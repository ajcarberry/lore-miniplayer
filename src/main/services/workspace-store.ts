import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import type { MainLogger } from '../ipc/logger';

// A persisted registry entry: the app-side record of a provisioned workspace.
// It carries only what Lore's per-store instance registry CANNOT be trusted to
// report from the repository's own checkout (the primary's private store lists
// only itself — see P18). Live fields (instanceId, revision, stale) are
// enriched at read time by querying the workspace's own path.
export const WorkspaceRegistryEntrySchema = z.object({
  repositoryId: z.string().min(1),
  path: z.string().min(1),
  branchName: z.string().min(1),
  provisionedAt: z.string().datetime(),
});

export type WorkspaceRegistryEntry = z.infer<typeof WorkspaceRegistryEntrySchema>;

const WorkspaceStoreFileSchema = z.object({
  workspaces: z.array(WorkspaceRegistryEntrySchema),
  version: z.string(),
});

interface WorkspaceStoreFile {
  readonly workspaces: WorkspaceRegistryEntry[];
  readonly version: string;
}

// Persistent, app-side registry of provisioned workspaces, stored as
// `workspaces.json` under Electron's userData directory. Mirrors the repository
// store's load/save discipline: validated on read and write, self-healing on a
// missing file, throwing (never silently empty) on a corrupt one. This is the
// source of truth for WHICH workspaces exist, because Lore's instance registry
// is per-store and the repository's primary checkout cannot see shared-store
// worktrees.
export class WorkspaceStore {
  private readonly storePath: string;
  private entries: WorkspaceRegistryEntry[] = [];
  private readonly STORE_VERSION = '1.0.0';

  constructor(private readonly log: MainLogger) {
    this.storePath = path.join(app.getPath('userData'), 'workspaces.json');
  }

  async list(): Promise<WorkspaceRegistryEntry[]> {
    await this.load();
    return [...this.entries];
  }

  async listByRepository(repositoryId: string): Promise<WorkspaceRegistryEntry[]> {
    await this.load();
    return this.entries.filter(entry => entry.repositoryId === repositoryId);
  }

  async findByPath(workspacePath: string): Promise<WorkspaceRegistryEntry | undefined> {
    await this.load();
    return this.entries.find(entry => this.samePath(entry.path, workspacePath));
  }

  // Register (or refresh) a workspace, keyed by resolved path so re-provisioning
  // or adopting the same directory never duplicates it.
  async add(entry: WorkspaceRegistryEntry): Promise<void> {
    const validated = WorkspaceRegistryEntrySchema.parse(entry);
    await this.load();
    const index = this.entries.findIndex(existing => this.samePath(existing.path, validated.path));
    if (index === -1) {
      this.entries.push(validated);
    } else {
      this.entries[index] = validated;
    }
    await this.save();
  }

  async remove(workspacePath: string): Promise<void> {
    await this.load();
    this.entries = this.entries.filter(entry => !this.samePath(entry.path, workspacePath));
    await this.save();
  }

  private async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.storePath, 'utf-8');
      const parsed = JSON.parse(data) as unknown;
      const validated = WorkspaceStoreFileSchema.parse(parsed);
      this.entries = [...validated.workspaces];
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        this.entries = [];
        await this.save();
      } else {
        this.log.error('Failed to load workspaces', {
          error,
          storePath: this.storePath,
          operation: 'workspace-store:load',
        });
        throw new Error(
          `Failed to load workspaces: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  private async save(): Promise<void> {
    const store: WorkspaceStoreFile = {
      workspaces: this.entries,
      version: this.STORE_VERSION,
    };
    const validated = WorkspaceStoreFileSchema.parse(store);
    await fs.writeFile(this.storePath, JSON.stringify(validated, null, 2), 'utf-8');
  }

  private samePath(a: string, b: string): boolean {
    return path.resolve(a) === path.resolve(b);
  }
}
