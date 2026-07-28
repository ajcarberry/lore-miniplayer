// Provisions version-pinned `loreserver` and `lore` binaries from GitHub
// Releases, caching them on disk. Never relies on anything on PATH.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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

const GITHUB_REPO = 'EpicGames/lore';
const BIN_NAMES = ['loreserver', 'lore'] as const;
type BinName = (typeof BIN_NAMES)[number];

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const CACHE_ROOT = join(REPO_ROOT, '.lore-test-cache', 'lore-bins');

const SdkPackageSchema = z.object({ version: z.string() });
const ReleaseAssetSchema = z.object({
  name: z.string(),
  url: z.string(),
  digest: z.string().nullish(), // e.g. "sha256:<hex>"; absent on older releases
});
const ReleaseSchema = z.object({ assets: z.array(ReleaseAssetSchema) });
type ReleaseAsset = z.infer<typeof ReleaseAssetSchema>;

/**
 * Resolves cached, executable binary paths; downloads and caches on a miss.
 * Pass an isolated `cacheRoot` to force a cold download without touching the
 * shared cache.
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
      throw new Error(`Unsupported architecture for Lore binaries: ${value}`);
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
      throw new Error(`Unsupported OS for Lore binaries: ${value}`);
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

function ghHeaders(accept: string): Record<string, string> {
  const token = process.env['GITHUB_TOKEN'] ?? process.env['LORE_GH_TOKEN'];
  return {
    Accept: accept,
    'User-Agent': 'lore-miniplayer-integration-tests',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchReleaseAssets(version: string): Promise<ReadonlyArray<ReleaseAsset>> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${version}`;
  const res = await fetch(url, { headers: ghHeaders('application/vnd.github+json') });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch release metadata for v${version} from ${GITHUB_REPO}: ${res.status} ${res.statusText}`
    );
  }
  const json: unknown = await res.json();
  return ReleaseSchema.parse(json).assets;
}

function resolveAsset(
  assets: ReadonlyArray<ReleaseAsset>,
  bin: BinName,
  version: string,
  triple: string
): ReleaseAsset {
  const expected = `${bin}-v${version}-${triple}.tar.gz`;
  const asset = assets.find(candidate => candidate.name === expected);
  if (!asset) {
    throw new Error(`No release asset matching "${expected}" found in ${GITHUB_REPO} v${version}`);
  }
  return asset;
}

// Download an asset, verifying its bytes before they are extracted and run.
async function downloadAsset(asset: ReleaseAsset, destFile: string): Promise<void> {
  const res = await fetch(asset.url, { headers: ghHeaders('application/octet-stream') });
  if (!res.ok) {
    throw new Error(`Failed to download ${asset.url}: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  verifyDigest(asset, buffer);
  await writeFile(destFile, buffer);
}

// Enforce the release's sha256 digest ("sha256:<hex>"). Other algorithms or an
// absent digest go unverified, so the check only ever tightens trust.
function verifyDigest(asset: ReleaseAsset, buffer: Buffer): void {
  const prefix = 'sha256:';
  if (asset.digest === undefined || asset.digest === null || !asset.digest.startsWith(prefix)) {
    return;
  }
  const expected = asset.digest.slice(prefix.length);
  const actual = createHash('sha256').update(buffer).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${asset.name}: expected sha256 ${expected}, got ${actual}`
    );
  }
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
  assets: ReadonlyArray<ReleaseAsset>,
  version: string,
  triple: string,
  stagingRoot: string,
  cacheDir: string
): Promise<void> {
  const asset = resolveAsset(assets, bin, version, triple);
  const tarballPath = join(stagingRoot, `${bin}.tar.gz`);
  await downloadAsset(asset, tarballPath);

  const extractDir = join(stagingRoot, `${bin}-extracted`);
  await mkdir(extractDir, { recursive: true });
  await execFileAsync('tar', ['-xzf', tarballPath, '-C', extractDir]);

  const extracted = await findExecutable(extractDir, bin);
  if (!extracted) {
    throw new Error(
      `Archive for "${bin}" (v${version}, ${triple}) did not contain an executable named "${bin}"`
    );
  }
  await chmod(extracted, 0o755);
  // Rename within the cache root's filesystem: an atomic, last-writer-wins
  // move even if a concurrent run installs the same binary.
  await rename(extracted, join(cacheDir, bin));
}
