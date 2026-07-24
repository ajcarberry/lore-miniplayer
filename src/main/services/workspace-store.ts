import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import type { MainLogger } from '../ipc/logger';
import type { Repository } from '../../shared/types';
import { RepositorySchema } from '../../shared/schemas';
import { ACCENT_HUE_VALUES } from '../../shared/accent';

// The unified workspace registry (packet U1). One store class, one file
// (`workspaces.json`, version 2) that holds BOTH card-view repositories and
// provisioned worktrees as unified `Repository` entries (origin-tagged). It
// folds in the one legacy file that shipped — `repositories.json` (card-view
// repos) — once and idempotently, renaming it aside to `*.json.bak` (never
// deleting).
//
// RepositoryService and WorkspaceService each hold their own instance pointed
// at the same file; every method reloads from disk before acting, so the file
// stays the single source of truth (the pre-existing load-before-write
// discipline of both legacy stores).

const STORE_VERSION = '2.0.0';

const RegistryFileSchema = z.object({
  version: z.string(),
  workspaces: z.array(RepositorySchema),
});

// --- legacy shape (migration source only) ----------------------------------

// Legacy `repositories.json`: the card-view repo shape before unification.
// accentHue may be absent (it post-dates the earliest stores — back-filled).
const LegacyRepositorySchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  localPath: z.string(),
  accentHue: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const LegacyRepositoryFileSchema = z.object({
  version: z.string(),
  repositories: z.array(LegacyRepositorySchema),
});

type LegacyRepository = z.infer<typeof LegacyRepositorySchema>;

function accentHueForIndex(index: number): number {
  return ACCENT_HUE_VALUES[index % ACCENT_HUE_VALUES.length] as number;
}

export class WorkspaceRegistry {
  private readonly storePath: string;
  private readonly legacyRepoPath: string;
  private entries: Repository[] = [];
  // Memoized once per instance: the migration check is idempotent but reads
  // the legacy file from disk, so it runs a single time rather than on every
  // registry operation.
  private migration: Promise<void> | null = null;

  constructor(private readonly log: MainLogger) {
    const userData = app.getPath('userData');
    this.storePath = path.join(userData, 'workspaces.json');
    this.legacyRepoPath = path.join(userData, 'repositories.json');
  }

  // --- reads -----------------------------------------------------------------

  async all(): Promise<Repository[]> {
    await this.load();
    return [...this.entries];
  }

  async findById(id: string): Promise<Repository | undefined> {
    await this.load();
    return this.entries.find(entry => entry.id === id);
  }

  async findByLocalPath(localPath: string): Promise<Repository | undefined> {
    await this.load();
    return this.entries.find(entry => samePath(entry.localPath, localPath));
  }

  async findByUrl(url: string): Promise<Repository[]> {
    await this.load();
    return this.entries.filter(entry => entry.url === url);
  }

  // --- writes ----------------------------------------------------------------

  // Insert or replace by id (repository create/update).
  async upsertById(entry: Repository): Promise<void> {
    const validated = RepositorySchema.parse(entry);
    await this.load();
    const index = this.entries.findIndex(existing => existing.id === validated.id);
    if (index === -1) {
      this.entries.push(validated);
    } else {
      this.entries[index] = validated;
    }
    await this.save();
  }

  // Insert or replace by resolved localPath (workspace provision/adoption), so
  // re-provisioning the same directory never duplicates it.
  async upsertByLocalPath(entry: Repository): Promise<void> {
    const validated = RepositorySchema.parse(entry);
    await this.load();
    const index = this.entries.findIndex(existing =>
      samePath(existing.localPath, validated.localPath)
    );
    if (index === -1) {
      this.entries.push(validated);
    } else {
      this.entries[index] = validated;
    }
    await this.save();
  }

  async removeById(id: string): Promise<boolean> {
    await this.load();
    const before = this.entries.length;
    this.entries = this.entries.filter(entry => entry.id !== id);
    const removed = this.entries.length < before;
    if (removed) {
      await this.save();
    }
    return removed;
  }

  async removeByLocalPath(localPath: string): Promise<void> {
    await this.load();
    this.entries = this.entries.filter(entry => !samePath(entry.localPath, localPath));
    await this.save();
  }

  // Round-robin accent hue for the next entry (matches the legacy repo store).
  async nextAccentHue(): Promise<number> {
    await this.load();
    return accentHueForIndex(this.entries.length);
  }

  // --- load + migration ------------------------------------------------------

  private async load(): Promise<void> {
    this.migration ??= this.migrateIfNeeded();
    await this.migration;
    const raw = await this.readJsonIfExists(this.storePath);
    if (raw === null) {
      this.entries = [];
      return;
    }
    try {
      this.entries = [...RegistryFileSchema.parse(raw).workspaces];
    } catch (error) {
      this.log.error('Failed to load workspace registry', {
        error,
        storePath: this.storePath,
        operation: 'workspace-registry:load',
      });
      throw new Error(
        `Failed to load workspace registry: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async save(): Promise<void> {
    const validated = RegistryFileSchema.parse({
      version: STORE_VERSION,
      workspaces: this.entries,
    });
    await fs.writeFile(this.storePath, JSON.stringify(validated, null, 2), 'utf-8');
  }

  // Fold the legacy `repositories.json` (the one legacy store that shipped)
  // into the v2 registry exactly once. No-op when no legacy file lingers, so
  // it is safe across process restarts. Reads all sources into memory before
  // renaming anything aside, so a crash mid-migration never loses data.
  private async migrateIfNeeded(): Promise<void> {
    const rawRepositories = await this.readJsonIfExists(this.legacyRepoPath);
    if (rawRepositories === null) {
      return;
    }

    // A workspaces.json that is not valid v2 is corrupt: let the normal
    // load() surface it rather than clobbering it here.
    const rawWorkspaces = await this.readJsonIfExists(this.storePath);
    let existing: Repository[] = [];
    if (rawWorkspaces !== null) {
      const asV2 = RegistryFileSchema.safeParse(rawWorkspaces);
      if (!asV2.success) {
        return;
      }
      existing = asV2.data.workspaces;
    }

    const legacyRepositories = this.parseLegacyRepositories(rawRepositories);
    const merged = this.buildUnified(existing, legacyRepositories);

    await this.renameAside(this.legacyRepoPath);

    this.entries = merged;
    await this.save();

    this.log.info('Migrated workspace registry to v2', {
      operation: 'workspace-registry:migrate',
      repositories: legacyRepositories.length,
      total: merged.length,
    });
  }

  private parseLegacyRepositories(raw: unknown): LegacyRepository[] {
    const parsed = LegacyRepositoryFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Failed to load workspace registry: legacy repositories.json is corrupt`);
    }
    return parsed.data.repositories;
  }

  // Merge the legacy repositories into unified entries, deduplicating by
  // resolved localPath (existing v2 entries win; a legacy row for an
  // already-known path is skipped). Accent hues are back-filled round-robin
  // by final position.
  private buildUnified(
    existingV2: Repository[],
    legacyRepositories: LegacyRepository[]
  ): Repository[] {
    const unified: Repository[] = [...existingV2];
    const hasPath = (candidate: string): boolean =>
      unified.some(entry => samePath(entry.localPath, candidate));

    for (const repo of legacyRepositories) {
      if (hasPath(repo.localPath)) {
        continue;
      }
      unified.push(this.toAttached(repo, unified.length));
    }

    return unified;
  }

  private toAttached(repo: LegacyRepository, index: number): Repository {
    return RepositorySchema.parse({
      id: repo.id,
      name: repo.name,
      url: repo.url,
      localPath: repo.localPath,
      // Origin is indistinguishable retroactively (packet U1): use 'attached'.
      origin: 'attached',
      accentHue: typeof repo.accentHue === 'number' ? repo.accentHue : accentHueForIndex(index),
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
    });
  }

  private async readJsonIfExists(filePath: string): Promise<unknown> {
    const data = await fs.readFile(filePath, 'utf-8').catch((error: unknown) => {
      if ((error as { code?: string }).code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    if (data === null) {
      return null;
    }
    try {
      return JSON.parse(data) as unknown;
    } catch {
      // A file that is not valid JSON is reported as a distinct sentinel so the
      // caller treats it as corrupt rather than absent.
      return { __corrupt__: true };
    }
  }

  // Rename the legacy file to `*.json.bak` (never deleting it).
  private async renameAside(filePath: string): Promise<void> {
    const target = `${filePath}.bak`;
    await fs.rename(filePath, target);
    this.log.info('Backed up a legacy registry file', {
      operation: 'workspace-registry:migrate',
      from: filePath,
      to: target,
    });
  }
}

// Whether two registry entries belong to the same Lore repo (the grouping that
// binds an anchor repo to its provisioned worktrees). Prefer the stable
// `loreRepositoryId` when BOTH sides carry one — a repo's `url` can drift (an
// attached folder may still hold a `local://existing` placeholder, or differ in
// scheme) while its Lore id never does. Fall back to url equality otherwise.
export function sameLoreRepo(
  a: Pick<Repository, 'url' | 'loreRepositoryId'>,
  b: Pick<Repository, 'url' | 'loreRepositoryId'>
): boolean {
  if (a.loreRepositoryId && b.loreRepositoryId) {
    return a.loreRepositoryId === b.loreRepositoryId;
  }
  return a.url === b.url;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}
