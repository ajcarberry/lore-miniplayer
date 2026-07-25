// Spawns a hermetically isolated `loreserver`. A per-run config dir pins the
// store paths to a fresh temp dir and binds QUIC/gRPC/HTTP to free ports, so
// runs stay isolated and parallelizable. TMPDIR redirects the server's
// self-signed cert pair; HOME redirects the `lore` CLI's config.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { ensureLoreBinaries } from './binaries';

const execFileAsync = promisify(execFile);

export interface LoreTestServer {
  grpcUrl: string; // lore://127.0.0.1:<grpcPort>
  httpUrl: string; // http://127.0.0.1:<httpPort> — hosts /health_check
  dataDir: string;
  pid: number;
  // Create an empty server-hosted repo; returns its clone URL.
  createRepo(name: string): Promise<{ name: string; url: string }>;
  // Run the cached `lore` CLI wired to this server's isolated env.
  lore(args: string[]): Promise<{ stdout: string; stderr: string }>;
  stop(): Promise<void>;
}

// Redirect HOME/XDG_* at a throwaway dir. The `lore` CLI and the SDK's FFI
// both read one global config under $HOME; per-process isolation keeps
// concurrent test processes from corrupting each other's reads.
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

// Safety net: kill any still-tracked loreserver on process exit so a test that
// crashes without awaiting stop() leaves no orphan behind.
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
          // process may already be gone
        }
      }
    }
  });
}

// Bind a probe to an OS-chosen loopback port, tracking it in `probes` so the
// caller can hold it open (guaranteeing distinct ports) and close it later.
async function reserveFreePort(probes: Server[]): Promise<number> {
  const probe = createServer();
  probe.unref();
  probes.push(probe);
  return await new Promise((resolvePort, reject) => {
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Failed to allocate a free port for the test loreserver'));
        return;
      }
      resolvePort(address.port);
    });
  });
}

// Reserve two distinct loopback ports. Both probes stay bound until both ports
// are chosen, so the OS never returns the same one twice; a short race remains
// between closing the probes and the server binding, inherent to pre-allocation.
async function getFreePortPair(): Promise<{ grpcPort: number; httpPort: number }> {
  const probes: Server[] = [];
  try {
    const grpcPort = await reserveFreePort(probes);
    const httpPort = await reserveFreePort(probes);
    return { grpcPort, httpPort };
  } finally {
    await Promise.all(
      probes.map(probe => new Promise<void>(resolveClose => probe.close(() => resolveClose())))
    );
  }
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
  const serverTmpDir = join(runDir, 'tmp'); // holds the server's self-signed cert pair
  const homeDir = join(runDir, 'home'); // holds the `lore` CLI's client-side store
  const logPath = join(runDir, 'server.log');

  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(serverTmpDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
  ]);

  const { grpcPort, httpPort } = await getFreePortPair();
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
      // best-effort; a leftover temp dir is not fatal
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
