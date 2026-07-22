import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { MainLogger } from '../ipc/logger';
import type { Repository } from '../../shared/types';
import { RepositorySchema } from '../../shared/schemas';
import { ACCENT_HUE_VALUES } from '../../shared/accent';

// The unified workspace registry (packet U1). One store class, one file
// (`workspaces.json`, version 2) that holds BOTH card-view repositories and
// provisioned worktrees as unified `Repository` entries (origin-tagged). It
// migrates, once and idempotently, from the two legacy files it replaces:
// `repositories.json` (card-view repos) and the P18 `workspaces.json` (v1
// worktree registry), renaming each aside to `*.json.bak` (never deleting).
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

// --- legacy shapes (migration sources only) --------------------------------

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

// Legacy P18 `workspaces.json` v1: the skinny worktree registry entry.
const LegacyWorkspaceEntrySchema = z.object({
  repositoryId: z.string().min(1),
  path: z.string().min(1),
  branchName: z.string().min(1),
  provisionedAt: z.string(),
});

const LegacyWorkspaceFileSchema = z.object({
  version: z.string(),
  workspaces: z.array(LegacyWorkspaceEntrySchema),
});

type LegacyRepository = z.infer<typeof LegacyRepositorySchema>;
type LegacyWorkspaceEntry = z.infer<typeof LegacyWorkspaceEntrySchema>;

function accentHueForIndex(index: number): number {
  return ACCENT_HUE_VALUES[index % ACCENT_HUE_VALUES.length] as number;
}

export class WorkspaceRegistry {
  private readonly storePath: string;
  private readonly legacyRepoPath: string;
  private entries: Repository[] = [];

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
    await this.migrateIfNeeded();
    const data = await fs.readFile(this.storePath, 'utf-8').catch((error: unknown) => {
      if ((error as { code?: string }).code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    if (data === null) {
      // migrateIfNeeded always leaves a v2 file; this is defensive only.
      this.entries = [];
      await this.save();
      return;
    }
    try {
      const parsed = JSON.parse(data) as unknown;
      this.entries = [...RegistryFileSchema.parse(parsed).workspaces];
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

  // Migrate the two legacy files into the unified v2 registry exactly once.
  // No-op when the store is already v2 and no legacy `repositories.json`
  // lingers, so it is safe to call on every load and across process restarts.
  // Reads all sources into memory before renaming anything aside, so a crash
  // mid-migration never loses data.
  private async migrateIfNeeded(): Promise<void> {
    const rawWorkspaces = await this.readJsonIfExists(this.storePath);
    const rawRepositories = await this.readJsonIfExists(this.legacyRepoPath);
    const ws = this.classifyWorkspaces(rawWorkspaces);

    // Fresh install: nothing anywhere → seed an empty v2 file.
    if (rawWorkspaces === null && rawRepositories === null) {
      this.entries = [];
      await this.save();
      return;
    }

    // Already migrated (v2 present, no legacy repositories.json to fold in).
    if (ws.isV2 && rawRepositories === null) {
      return;
    }

    // A workspaces.json that is neither valid v2 nor valid v1 is corrupt: let
    // the normal load() surface it rather than clobbering it here.
    if (rawWorkspaces !== null && !ws.isV2 && !ws.isV1) {
      return;
    }

    await this.performMigration(ws, rawRepositories);
  }

  // Decide what the current workspaces.json is (v2, legacy v1, or neither) and
  // surface its already-parsed entries — v2 checked first so the two shapes
  // never overlap.
  private classifyWorkspaces(raw: unknown): {
    isV2: boolean;
    isV1: boolean;
    v2: Repository[];
    v1: LegacyWorkspaceEntry[];
  } {
    if (raw === null) {
      return { isV2: false, isV1: false, v2: [], v1: [] };
    }
    const asV2 = RegistryFileSchema.safeParse(raw);
    if (asV2.success) {
      return { isV2: true, isV1: false, v2: asV2.data.workspaces, v1: [] };
    }
    const asV1 = LegacyWorkspaceFileSchema.safeParse(raw);
    if (asV1.success) {
      return { isV2: false, isV1: true, v2: [], v1: asV1.data.workspaces };
    }
    return { isV2: false, isV1: false, v2: [], v1: [] };
  }

  // Merge legacy sources into a v2 file. Back up legacy files BEFORE
  // overwriting workspaces.json — only rename the workspaces.json file aside
  // when it was a v1 file being replaced; an existing v2 file is kept (merged
  // into). Sources are already in memory, so a crash mid-rename loses nothing.
  private async performMigration(
    ws: { isV1: boolean; v2: Repository[]; v1: LegacyWorkspaceEntry[] },
    rawRepositories: unknown
  ): Promise<void> {
    const legacyRepositories = this.parseLegacyRepositories(rawRepositories);
    const merged = this.buildUnified(ws.v2, legacyRepositories, ws.v1);

    if (ws.isV1) {
      await this.renameAside(this.storePath);
    }
    if (rawRepositories !== null) {
      await this.renameAside(this.legacyRepoPath);
    }

    this.entries = merged;
    await this.save();

    this.log.info('Migrated workspace registry to v2', {
      operation: 'workspace-registry:migrate',
      repositories: legacyRepositories.length,
      worktrees: ws.v1.length,
      total: merged.length,
    });
  }

  private parseLegacyRepositories(raw: unknown): LegacyRepository[] {
    if (raw === null) {
      return [];
    }
    const parsed = LegacyRepositoryFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Failed to load workspace registry: legacy repositories.json is corrupt`);
    }
    return parsed.data.repositories;
  }

  // Merge legacy sources into unified entries, deduplicating by resolved
  // localPath (existing v2 entries win; a legacy row for an already-known path
  // is skipped). Accent hues are back-filled round-robin by final position.
  private buildUnified(
    existingV2: Repository[],
    legacyRepositories: LegacyRepository[],
    legacyWorkspaces: LegacyWorkspaceEntry[]
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

    // A provisioned worktree joins its parent repo's url via repositoryId
    // (looked up among the legacy repositories it was registered against).
    const urlById = new Map(legacyRepositories.map(repo => [repo.id, repo.url]));
    for (const worktree of legacyWorkspaces) {
      if (hasPath(worktree.path)) {
        continue;
      }
      const url = urlById.get(worktree.repositoryId);
      if (url === undefined) {
        this.log.warn('Dropping an orphaned worktree during migration (parent repo not found)', {
          operation: 'workspace-registry:migrate',
          worktreePath: worktree.path,
          repositoryId: worktree.repositoryId,
        });
        continue;
      }
      unified.push(this.toProvisioned(worktree, url, unified.length));
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

  private toProvisioned(worktree: LegacyWorkspaceEntry, url: string, index: number): Repository {
    return RepositorySchema.parse({
      id: uuidv4() as string,
      // A provisioned workspace is named for its branch (branch names repeat
      // across repos — name uniqueness is per-url now).
      name: worktree.branchName,
      url,
      localPath: worktree.path,
      origin: 'provisioned',
      accentHue: accentHueForIndex(index),
      branchName: worktree.branchName,
      provisionedAt: worktree.provisionedAt,
      createdAt: worktree.provisionedAt,
      updatedAt: worktree.provisionedAt,
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

  // Rename a legacy file to `*.json.bak` without ever clobbering an existing
  // backup (a previously-migrated `.bak` is preserved; a suffix is appended).
  private async renameAside(filePath: string): Promise<void> {
    let target = `${filePath}.bak`;
    let counter = 1;
    while (await pathExists(target)) {
      target = `${filePath}.bak.${counter}`;
      counter += 1;
    }
    await fs.rename(filePath, target);
    this.log.info('Backed up a legacy registry file', {
      operation: 'workspace-registry:migrate',
      from: filePath,
      to: target,
    });
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
