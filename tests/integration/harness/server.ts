// Spawns a hermetically isolated `loreserver` for the integration test suite.
//
// Isolation mechanism (investigated via `loreserver --help` and by extracting
// the binary's embedded default.toml with `strings`/manual byte inspection):
// a per-run `--config` TOML pins `[immutable_store.local].path` and
// `[mutable_store.local].path` under a fresh temp dir, so each run's repos
// live in their own tree instead of the binary's undocumented default
// (`<tmp>/lore-server`). The same TOML sets `[server.quic].port` and
// `[server.grpc].port` (they share one numeric port in the shipped default
// too -- QUIC is UDP, gRPC is TCP, so this is safe) plus `[server.http].port`
// to dynamically-allocated free ports, so custom ports DO work and multiple
// servers can run in parallel. `TMPDIR`/`HOME` are additionally redirected
// (for the server process and every `lore` CLI call) to catch state the
// store-path keys don't cover -- confirmed empirically that the server's
// self-signed cert pair is written under `<TMPDIR>/lore-server` regardless
// of the store-path config, and that redirecting `HOME` for the `lore` CLI
// does not break `repository create`/`list` against a remote server.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { ensureLoreBinaries } from './binaries';

const execFileAsync = promisify(execFile);

export interface LoreTestServer {
  grpcUrl: string; // e.g. lore://127.0.0.1:<grpcPort>  (client/app connects here)
  httpUrl: string; // e.g. http://127.0.0.1:<httpPort>  (/health_check lives here)
  dataDir: string; // this run's isolated server storage dir
  pid: number; // the spawned loreserver process id, for orphan checks
  // Create an (empty) server-hosted repo; returns its clone URL (grpcUrl + '/' + name).
  createRepo(name: string): Promise<{ name: string; url: string }>;
  // Run the cached `lore` CLI wired to THIS server's context (isolated env).
  // Lets tests seed repos and act as a second client ("Devin").
  lore(args: string[]): Promise<{ stdout: string; stderr: string }>;
  stop(): Promise<void>;
}

// The SDK's native FFI and the `lore` CLI both read one global Lore config
// under $HOME; redirecting HOME/XDG_* at a throwaway dir keeps each test
// process (and each launched app) hermetic. Shared by the integration world,
// this server's own client env, and the live-server e2e setup.
export function isolatedHomeEnv(homeDir: string): {
  HOME: string;
  XDG_CONFIG_HOME: string;
  XDG_DATA_HOME: string;
} {
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    XDG_DATA_HOME: join(homeDir, '.local', 'share'),
  };
}

const HEALTH_CHECK_TIMEOUT_MS = 15_000;
const HEALTH_CHECK_INTERVAL_MS = 100;
const STOP_GRACE_MS = 5_000;
const LOG_TAIL_CHARS = 4_000;

// Safety net: if a test crashes without awaiting stop(), kill any loreserver
// this process still has tracked rather than leaving an orphan behind.
const trackedServers = new Set<ChildProcess>();
let exitHandlerRegistered = false;

function registerExitSafetyNet(): void {
  if (exitHandlerRegistered) {
    return;
  }
  exitHandlerRegistered = true;
  process.on('exit', () => {
    for (const child of trackedServers) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // best-effort: the process may already be gone
        }
      }
    }
  });
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('Failed to allocate a free port for the test loreserver'));
        return;
      }
      const { port } = address;
      probe.close(() => {
        resolvePort(port);
      });
    });
  });
}

async function readLogTail(logPath: string): Promise<string> {
  const contents = await readFile(logPath, 'utf8').catch(() => '(log file unavailable)');
  return contents.length > LOG_TAIL_CHARS ? contents.slice(-LOG_TAIL_CHARS) : contents;
}

export async function startLoreServer(opts?: { version?: string }): Promise<LoreTestServer> {
  registerExitSafetyNet();

  const bins = await ensureLoreBinaries(opts?.version);
  const runDir = await mkdtemp(join(tmpdir(), 'lore-test-server-'));
  const configDir = join(runDir, 'config');
  const dataDir = join(runDir, 'store');
  const serverTmpDir = join(runDir, 'tmp'); // isolates the server's self-signed cert pair
  const homeDir = join(runDir, 'home'); // isolates the `lore` CLI's client-side local store
  const logPath = join(runDir, 'server.log');

  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(serverTmpDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
  ]);

  const grpcPort = await getFreePort();
  const httpPort = await getFreePort();
  const grpcUrl = `lore://127.0.0.1:${grpcPort}`;
  const httpUrl = `http://127.0.0.1:${httpPort}`;

  await writeServerConfig(configDir, grpcPort, httpPort, dataDir);

  const clientEnv: Record<string, string | undefined> = {
    ...process.env,
    ...isolatedHomeEnv(homeDir),
    TMPDIR: serverTmpDir,
  };

  const logFd = openSync(logPath, 'a');
  let logFdOpen = true;
  const closeLogFd = (): void => {
    if (logFdOpen) {
      logFdOpen = false;
      closeSync(logFd);
    }
  };

  const child = spawn(bins.loreserver, ['--config', configDir], {
    env: clientEnv,
    stdio: ['ignore', logFd, logFd],
  });
  trackedServers.add(child);

  const spawnPid = child.pid;
  if (spawnPid === undefined) {
    closeLogFd();
    trackedServers.delete(child);
    throw new Error(`Failed to spawn loreserver from ${bins.loreserver}`);
  }

  try {
    await waitForHealthy(httpUrl, logPath, child);
  } catch (error) {
    child.kill('SIGKILL');
    closeLogFd();
    trackedServers.delete(child);
    throw error;
  }

  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    trackedServers.delete(child);

    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolveExit => {
        const forceKillTimer = global.setTimeout(() => {
          child.kill('SIGKILL');
        }, STOP_GRACE_MS);
        child.once('exit', () => {
          global.clearTimeout(forceKillTimer);
          resolveExit();
        });
        child.kill('SIGTERM');
      });
    }

    closeLogFd();
    await rm(runDir, { recursive: true, force: true }).catch(() => {
      // best-effort cleanup; leaving a temp dir behind is not fatal
    });
  };

  const lore = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    const { stdout, stderr } = await execFileAsync(bins.lore, args, {
      env: clientEnv,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr };
  };

  const createRepo = async (name: string): Promise<{ name: string; url: string }> => {
    const url = `${grpcUrl}/${name}`;
    const localDir = join(runDir, 'repos', `${name}-${randomUUID()}`);
    await mkdir(localDir, { recursive: true });
    await lore(['repository', 'create', url, '--repository', localDir]);
    return { name, url };
  };

  return {
    grpcUrl,
    httpUrl,
    dataDir,
    pid: spawnPid,
    createRepo,
    lore,
    stop,
  };
}

async function waitForHealthy(
  httpUrl: string,
  logPath: string,
  child: ChildProcess
): Promise<void> {
  const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const logTail = await readLogTail(logPath);
      throw new Error(
        `loreserver exited before becoming healthy (code=${String(child.exitCode)}, signal=${String(
          child.signalCode
        )}).\n--- log tail ---\n${logTail}`
      );
    }

    try {
      const res = await fetch(`${httpUrl}/health_check`);
      if (res.status === 200) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(HEALTH_CHECK_INTERVAL_MS);
  }

  const logTail = await readLogTail(logPath);
  throw new Error(
    `loreserver did not become healthy within ${HEALTH_CHECK_TIMEOUT_MS}ms (last error: ${String(
      lastError
    )}).\n--- log tail ---\n${logTail}`
  );
}

async function writeServerConfig(
  configDir: string,
  grpcPort: number,
  httpPort: number,
  dataDir: string
): Promise<void> {
  const toml = [
    '[server.quic]',
    `port = ${grpcPort}`,
    '',
    '[server.grpc]',
    `port = ${grpcPort}`,
    '',
    '[server.http]',
    `port = ${httpPort}`,
    '',
    '[immutable_store.local]',
    `path = "${join(dataDir, 'immutable')}"`,
    '',
    '[mutable_store.local]',
    `path = "${join(dataDir, 'mutable')}"`,
    '',
  ].join('\n');
  await writeFile(join(configDir, 'local.toml'), toml);
}
