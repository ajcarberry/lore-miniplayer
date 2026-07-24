// Setup helpers for the integration suites.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startLoreServer, isolatedHomeEnv, type LoreTestServer } from '../harness/server';
import { LoreRepositoryService } from '../../../src/main/services/lore-repository';

export interface World {
  server: LoreTestServer;
  service: LoreRepositoryService;
}

// LoreRepositoryService drives the SDK's FFI in-process, which reads and writes
// one global config under $HOME. Concurrent test processes cloning at once
// corrupt each other's reads of that shared file, so redirect HOME/XDG_* for
// this process once. Each `node --test` file is its own OS process, so this
// never leaks across concurrently-running test files.
let ffiHomeReady: Promise<void> | undefined;

async function ensureIsolatedFfiHome(): Promise<void> {
  ffiHomeReady ??= (async (): Promise<void> => {
    const homeDir = await mkdtemp(join(tmpdir(), 'lore-ffi-home-'));
    Object.assign(process.env, isolatedHomeEnv(homeDir));
  })();
  return ffiHomeReady;
}

// Start a hermetic server and a fresh LoreRepositoryService for one test,
// guaranteeing teardown and listener cleanup even when `fn` throws.
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

// File content to seed, keyed by repo-relative path. Buffers allow binary bytes
// alongside plain text.
export type SeedFiles = Record<string, string | Buffer>;

export interface SeededRepo {
  readonly name: string;
  readonly url: string;
  readonly workdir: string; // seeding working copy, already committed + pushed
}

// Write a map of files into `root`, creating parent dirs.
export async function writeSeedFiles(root: string, files: SeedFiles): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(root, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
}

// stageFiles/unstageFiles take absolute paths: the IPC layer joins the
// renderer's repo-relative paths against repositoryPath before calling the
// service, so tests must pass absolute paths too.
export function abs(repositoryPath: string, relPath: string): string {
  return join(repositoryPath, relPath);
}

// Create a server repo and seed initial content via the `lore` CLI in a temp
// working dir: create, write, stage, commit, push.
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

// Seed a repo on the server, then clone it as the primary user.
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
  // Write, stage, commit, and push in one call.
  commitAndPush(files: SeedFiles, message: string): Promise<void>;
}

// Clone `repoUrl` into a separate working dir as a second user, able to move
// the remote independently of the primary clone.
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

// A small text mesh manifest and a binary texture: realistic asset shapes
// without large fixtures.
export function islandCavesFiles(): SeedFiles {
  return {
    'meshes/cave-entrance.mesh': 'mesh-format-v1\nvertices: 128\nfaces: 64\n',
    'textures/rock-diffuse.tga': Buffer.from([
      0x54, 0x52, 0x55, 0x45, 0x00, 0x01, 0xff, 0x00, 0x10, 0x20,
    ]),
  };
}
