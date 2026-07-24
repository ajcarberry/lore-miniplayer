// Provisions version-pinned `loreserver` and `lore` binaries for the
// integration test suite, downloading them once from GitHub Releases and
// caching them on disk. Does NOT rely on anything on PATH.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { arch as osArch, platform as osPlatform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

export interface LoreBinaries {
  loreserver: string;
  lore: string;
  version: string;
}

export class LoreBinaryProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoreBinaryProvisionError';
  }
}

const GITHUB_REPO = 'EpicGames/lore';
const BIN_NAMES = ['loreserver', 'lore'] as const;
type BinName = (typeof BIN_NAMES)[number];

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const CACHE_ROOT = join(REPO_ROOT, '.lore-test-cache', 'lore-bins');

const SdkPackageSchema = z.object({ version: z.string() });
const ReleaseAssetSchema = z.object({ name: z.string(), url: z.string() });
const ReleaseSchema = z.object({ assets: z.array(ReleaseAssetSchema) });

/**
 * Resolves cached, executable binary paths; downloads+caches on a miss.
 * `cacheRoot` defaults to the shared on-disk cache — pass an isolated
 * directory (e.g. under `os.tmpdir()`) for tests that need to force a cold
 * download without disturbing binaries other concurrently-running tests rely on.
 */
export async function ensureLoreBinaries(
  version?: string,
  cacheRoot: string = CACHE_ROOT
): Promise<LoreBinaries> {
  const resolvedVersion = version ?? (await defaultVersion());
  const triple = resolvePlatformTriple();
  const cacheDir = join(cacheRoot, resolvedVersion, triple);
  const loreserverPath = join(cacheDir, 'loreserver');
  const lorePath = join(cacheDir, 'lore');

  if ((await isExecutable(loreserverPath)) && (await isExecutable(lorePath))) {
    return { loreserver: loreserverPath, lore: lorePath, version: resolvedVersion };
  }

  const assets = await fetchReleaseAssets(resolvedVersion);
  const stagingRoot = join(cacheRoot, '.staging', `${resolvedVersion}-${triple}-${randomUUID()}`);
  await mkdir(stagingRoot, { recursive: true });
  try {
    await mkdir(cacheDir, { recursive: true });
    for (const bin of BIN_NAMES) {
      await installBinary(bin, assets, resolvedVersion, triple, stagingRoot, cacheDir);
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch((error: unknown) => {
      console.warn(`ensureLoreBinaries: failed to clean up staging dir ${stagingRoot}`, error);
    });
  }

  return { loreserver: loreserverPath, lore: lorePath, version: resolvedVersion };
}

async function defaultVersion(): Promise<string> {
  const pkgPath = join(REPO_ROOT, 'node_modules', '@lore-vcs', 'sdk', 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  const pkg = SdkPackageSchema.parse(JSON.parse(raw) as unknown);
  return pkg.version;
}

function resolvePlatformTriple(): string {
  return `${mapArch(osArch())}-${mapOs(osPlatform())}`;
}

function mapArch(value: string): string {
  switch (value) {
    case 'arm64':
    case 'aarch64':
      return 'aarch64';
    case 'x64':
    case 'x86_64':
    case 'amd64':
      return 'x86_64';
    default:
      throw new LoreBinaryProvisionError(`Unsupported architecture for Lore binaries: ${value}`);
  }
}

function mapOs(value: string): string {
  switch (value) {
    case 'darwin':
    case 'Darwin':
      return 'apple-darwin';
    case 'linux':
    case 'Linux':
      return 'unknown-linux-gnu';
    default:
      throw new LoreBinaryProvisionError(`Unsupported OS for Lore binaries: ${value}`);
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function authHeaders(): Record<string, string> {
  const token = process.env['GITHUB_TOKEN'] ?? process.env['LORE_GH_TOKEN'];
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchReleaseAssets(
  version: string
): Promise<ReadonlyArray<{ name: string; url: string }>> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${version}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lore-miniplayer-integration-tests',
      ...authHeaders(),
    },
  });
  if (!res.ok) {
    throw new LoreBinaryProvisionError(
      `Failed to fetch release metadata for v${version} from ${GITHUB_REPO}: ${res.status} ${res.statusText}`
    );
  }
  const json: unknown = await res.json();
  return ReleaseSchema.parse(json).assets;
}

function resolveAssetUrl(
  assets: ReadonlyArray<{ name: string; url: string }>,
  bin: BinName,
  version: string,
  triple: string
): string {
  const pattern = new RegExp(
    `^${escapeRegExp(bin)}-v${escapeRegExp(version)}-${escapeRegExp(triple)}\\.tar\\.gz$`
  );
  const asset = assets.find(candidate => pattern.test(candidate.name));
  if (!asset) {
    throw new LoreBinaryProvisionError(
      `No release asset matching "${bin}-v${version}-${triple}.tar.gz" found in ${GITHUB_REPO} v${version}`
    );
  }
  return asset.url;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function downloadAsset(assetUrl: string, destFile: string): Promise<void> {
  const res = await fetch(assetUrl, {
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'lore-miniplayer-integration-tests',
      ...authHeaders(),
    },
  });
  if (!res.ok) {
    throw new LoreBinaryProvisionError(
      `Failed to download ${assetUrl}: ${res.status} ${res.statusText}`
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(destFile, buffer);
}

async function findExecutable(dir: string, name: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findExecutable(full, name);
      if (found) {
        return found;
      }
    } else if (entry.isFile() && entry.name === name) {
      return full;
    }
  }
  return undefined;
}

async function installBinary(
  bin: BinName,
  assets: ReadonlyArray<{ name: string; url: string }>,
  version: string,
  triple: string,
  stagingRoot: string,
  cacheDir: string
): Promise<void> {
  const assetUrl = resolveAssetUrl(assets, bin, version, triple);
  const tarballPath = join(stagingRoot, `${bin}.tar.gz`);
  await downloadAsset(assetUrl, tarballPath);

  const extractDir = join(stagingRoot, `${bin}-extracted`);
  await mkdir(extractDir, { recursive: true });
  await execFileAsync('tar', ['-xzf', tarballPath, '-C', extractDir]);

  const extracted = await findExecutable(extractDir, bin);
  if (!extracted) {
    throw new LoreBinaryProvisionError(
      `Archive for "${bin}" (v${version}, ${triple}) did not contain an executable named "${bin}"`
    );
  }
  await chmod(extracted, 0o755);
  // Rename within the cache root's filesystem so this is an atomic,
  // last-writer-wins move even if a concurrent run installs the same binary.
  await rename(extracted, join(cacheDir, bin));
}
