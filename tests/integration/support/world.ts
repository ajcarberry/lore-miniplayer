// Shared setup helpers for the service-layer workflow (WP4) and edge-case
// (WP5) integration suites. Dependency-free beyond Node builtins + the
// harness + the service under test, so WP5 can import these directly.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startLoreServer, isolatedHomeEnv, type LoreTestServer } from '../harness/server';
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
    Object.assign(process.env, isolatedHomeEnv(homeDir));
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

// Write (creating parent dirs for) a map of files into `root`.
export async function writeSeedFiles(root: string, files: SeedFiles): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(root, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
}

// stageFiles/unstageFiles take ABSOLUTE paths -- the IPC layer
// (src/main/ipc/lore-handlers.ts) joins the renderer's repo-relative paths
// against repositoryPath before calling the service; tests reproduce that
// join rather than calling the service off-contract.
export function abs(repositoryPath: string, relPath: string): string {
  return join(repositoryPath, relPath);
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

// The common "seed a repo on the server, then clone it as the primary user"
// arrange step. Returns the seeded repo and the fresh clone's path on disk.
export async function seedAndClone(
  server: LoreTestServer,
  service: LoreRepositoryService,
  name: string,
  files: SeedFiles
): Promise<{ repo: SeededRepo; clonePath: string }> {
  const repo = await seedRepo(server, name, files);
  const clonePath = await mkdtemp(join(tmpdir(), `lore-clone-${name}-`));
  await service.cloneRepository(repo.url, clonePath);
  return { repo, clonePath };
}

export interface SecondClient {
  readonly workdir: string;
  // The common "teammate moves the remote" shape: write, stage everything,
  // commit, push, in one call.
  commitAndPush(files: SeedFiles, message: string): Promise<void>;
}

// Clone `repoUrl` into a SEPARATE working dir as a second user (e.g.
// "Devin"), so a test can move the remote out from under the primary clone.
export async function secondClient(
  server: LoreTestServer,
  repoUrl: string,
  name = 'devin'
): Promise<SecondClient> {
  const workdir = await mkdtemp(join(tmpdir(), `lore-${name}-`));
  await server.lore(['clone', repoUrl, workdir]);

  const commitAndPush = async (files: SeedFiles, message: string): Promise<void> => {
    await writeSeedFiles(workdir, files);
    await server.lore(['stage', '.', '--scan', '--repository', workdir]);
    await server.lore(['commit', message, '--repository', workdir]);
    await server.lore(['push', '--repository', workdir]);
  };

  return { workdir, commitAndPush };
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
