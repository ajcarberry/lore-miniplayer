// Shared setup helpers for the service-layer workflow (WP4) and edge-case
// (WP5) integration suites. Dependency-free beyond Node builtins + the
// harness + the service under test, so WP5 can import these directly.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startLoreServer, type LoreTestServer } from '../harness/server';
import { LoreRepositoryService } from '../../../src/main/services/lore-repository';

export interface World {
  server: LoreTestServer;
  service: LoreRepositoryService;
}

// LoreRepositoryService drives the SDK's native FFI in-process (no `lore`
// CLI subprocess, so none of harness/server.ts's per-run HOME isolation
// applies to it). Left alone, the FFI reads/writes ONE real global config
// file under the developer's actual $HOME (macOS:
// ~/Library/Application Support/com.epicgames.urc/global.toml, confirmed via
// `strings` on the cached binary) -- observed empirically as a real,
// non-hermetic race: concurrent integration test files clone at the same
// time, both FFI clients hit that single shared file, and one occasionally
// reads it mid-write ("Loading global config: failed to parse config").
// Isolating HOME/XDG_* for this process only, once, fixes it -- each
// `node --test` file is its own OS process, so this never leaks across
// concurrently-running test files.
let ffiHomeReady: Promise<void> | undefined;

async function ensureIsolatedFfiHome(): Promise<void> {
  ffiHomeReady ??= (async (): Promise<void> => {
    const homeDir = await mkdtemp(join(tmpdir(), 'lore-ffi-home-'));
    process.env['HOME'] = homeDir;
    process.env['XDG_CONFIG_HOME'] = join(homeDir, '.config');
    process.env['XDG_DATA_HOME'] = join(homeDir, '.local', 'share');
  })();
  return ffiHomeReady;
}

// Start a hermetic server + a fresh LoreRepositoryService for one test, and
// guarantee server teardown + listener cleanup even when `fn` throws.
export async function withServer<T>(fn: (world: World) => Promise<T>): Promise<T> {
  await ensureIsolatedFfiHome();
  const server = await startLoreServer();
  const service = new LoreRepositoryService();
  try {
    return await fn({ server, service });
  } finally {
    service.removeAllListeners();
    await server.stop();
  }
}

// File content to seed, keyed by path relative to the repo root. Buffers let
// callers seed binary-ish asset bytes alongside plain text, per the project's
// realistic-test-data guidance.
export type SeedFiles = Record<string, string | Buffer>;

export interface SeededRepo {
  readonly name: string;
  readonly url: string;
  readonly workdir: string; // the seeding working copy -- already committed + pushed
}

async function writeSeedFiles(root: string, files: SeedFiles): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(root, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
}

// Create a server repo and give it initial content by driving the `lore`
// CLI in a temp working dir: create -> write files -> stage -> commit ->
// push. This is how the "studio" starts with real revisions to clone.
export async function seedRepo(
  server: LoreTestServer,
  name: string,
  files: SeedFiles,
  message = 'Initial commit'
): Promise<SeededRepo> {
  const workdir = await mkdtemp(join(tmpdir(), `lore-seed-${name}-`));
  const url = `${server.grpcUrl}/${name}`;
  await server.lore(['repository', 'create', url, '--repository', workdir]);
  await writeSeedFiles(workdir, files);
  await server.lore(['stage', '.', '--scan', '--repository', workdir]);
  await server.lore(['commit', message, '--repository', workdir]);
  await server.lore(['push', '--repository', workdir]);
  return { name, url, workdir };
}

export interface SecondClient {
  readonly name: string;
  readonly workdir: string;
  // Write (and create parent dirs for) files in this client's working copy
  // without staging/committing them.
  writeFiles(files: SeedFiles): Promise<void>;
  stage(paths?: string[]): Promise<void>;
  commit(message: string): Promise<void>;
  push(): Promise<void>;
  // Convenience for the common "teammate moves the remote" shape: write,
  // stage everything, commit, push, in one call.
  commitAndPush(files: SeedFiles, message: string): Promise<void>;
}

// Clone `repoUrl` into a SEPARATE working dir as a second user (e.g.
// "Devin"), with helpers to edit/stage/commit/push there so a test can move
// the remote out from under the primary clone. General-purpose: WP5's
// divergence/conflict scenarios reuse this heavily.
export async function secondClient(
  server: LoreTestServer,
  repoUrl: string,
  name = 'devin'
): Promise<SecondClient> {
  const workdir = await mkdtemp(join(tmpdir(), `lore-${name}-`));
  await server.lore(['clone', repoUrl, workdir]);

  const writeFiles = async (files: SeedFiles): Promise<void> => {
    await writeSeedFiles(workdir, files);
  };
  const stage = async (paths: string[] = ['.']): Promise<void> => {
    await server.lore(['stage', ...paths, '--scan', '--repository', workdir]);
  };
  const commit = async (message: string): Promise<void> => {
    await server.lore(['commit', message, '--repository', workdir]);
  };
  const push = async (): Promise<void> => {
    await server.lore(['push', '--repository', workdir]);
  };
  const commitAndPush = async (files: SeedFiles, message: string): Promise<void> => {
    await writeFiles(files);
    await stage();
    await commit(message);
    await push();
  };

  return { name, workdir, writeFiles, stage, commit, push, commitAndPush };
}

// A small text "mesh manifest" and a binary-ish "texture" -- realistic
// enough asset shapes for the studio's island-caves project without needing
// large fixtures.
export function islandCavesFiles(): SeedFiles {
  return {
    'meshes/cave-entrance.mesh': 'mesh-format-v1\nvertices: 128\nfaces: 64\n',
    'textures/rock-diffuse.tga': Buffer.from([
      0x54, 0x52, 0x55, 0x45, 0x00, 0x01, 0xff, 0x00, 0x10, 0x20,
    ]),
  };
}
