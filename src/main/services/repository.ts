import { v4 as uuidv4 } from 'uuid';
import type { MainLogger } from '../ipc/logger';
import type {
  Repository,
  RepositoryCreateInput,
  RepositoryUpdateInput,
  WorkspaceOrigin,
} from '../../shared/types';
import {
  RepositorySchema,
  RepositoryCreateInputSchema,
  RepositoryUpdateInputSchema,
} from '../../shared/schemas';
import { WorkspaceRegistry } from './workspace-store';

// Card-view origins: the entries `getAll` surfaces to the repository list. A
// `provisioned` worktree is tracked in the same unified registry but is a
// Mission Control concept, not a card-view repository (surfacing them in the
// card view is U2/U3's job). `getById`/`delete` still reach every origin.
const CARD_VIEW_ORIGINS: readonly WorkspaceOrigin[] = ['attached', 'cloned'];

// Manages card-view repositories, persisted in the unified workspace registry
// (`workspaces.json`, packet U1). The public API is unchanged from the legacy
// repository store — create/update/delete/getAll/getById — but every entry now
// carries the unified shape (with `origin`), uniqueness on name is scoped
// per-url (branch-named provisioned entries repeat across repos), and `delete`
// is a non-destructive "forget" for ALL origins.
export class RepositoryService {
  private readonly registry: WorkspaceRegistry;

  constructor(log: MainLogger) {
    this.registry = new WorkspaceRegistry(log);
  }

  async initialize(): Promise<void> {
    // Triggers migration from the two legacy files and seeds an empty v2 store
    // on first run; idempotent across restarts.
    await this.registry.all();
  }

  async getAll(): Promise<Repository[]> {
    const entries = await this.registry.all();
    return entries.filter(entry => CARD_VIEW_ORIGINS.includes(entry.origin));
  }

  async getById(id: string): Promise<Repository | null> {
    return (await this.registry.findById(id)) ?? null;
  }

  async create(
    input: RepositoryCreateInput,
    origin: WorkspaceOrigin = 'attached'
  ): Promise<Repository> {
    const validatedInput = RepositoryCreateInputSchema.parse(input);

    const entries = await this.registry.all();
    this.assertUniqueLocalPath(entries, validatedInput.localPath);
    this.assertUniqueNameForUrl(entries, validatedInput.url, validatedInput.name);

    const now = new Date().toISOString();
    const newRepository = RepositorySchema.parse({
      id: uuidv4() as string,
      name: validatedInput.name,
      url: validatedInput.url,
      localPath: validatedInput.localPath,
      accentHue: await this.registry.nextAccentHue(),
      origin,
      createdAt: now,
      updatedAt: now,
    });

    await this.registry.upsertById(newRepository);
    return newRepository;
  }

  async update(input: RepositoryUpdateInput): Promise<Repository> {
    const validatedInput = RepositoryUpdateInputSchema.parse(input);

    const entries = await this.registry.all();
    const current = entries.find(entry => entry.id === validatedInput.id);
    if (!current) {
      throw new Error(`Repository with id "${validatedInput.id}" not found`);
    }

    const nextUrl = validatedInput.url ?? current.url;
    if (validatedInput.name) {
      this.assertUniqueNameForUrl(entries, nextUrl, validatedInput.name, current.id);
    }
    if (validatedInput.localPath) {
      this.assertUniqueLocalPath(entries, validatedInput.localPath, current.id);
    }

    const updated = RepositorySchema.parse({
      ...current,
      name: validatedInput.name ?? current.name,
      url: nextUrl,
      localPath: validatedInput.localPath ?? current.localPath,
      accentHue: validatedInput.accentHue ?? current.accentHue,
      updatedAt: new Date().toISOString(),
    });

    await this.registry.upsertById(updated);
    return updated;
  }

  // "Forget" a workspace entry — untrack-only, non-destructive, for ALL origins
  // (a provisioned worktree can be forgotten without teardown). The guarded
  // destructive path lives in WorkspaceService.teardown.
  async delete(id: string): Promise<void> {
    const removed = await this.registry.removeById(id);
    if (!removed) {
      throw new Error(`Repository with id "${id}" not found`);
    }
  }

  // --- internals -------------------------------------------------------------

  private assertUniqueLocalPath(
    entries: Repository[],
    localPath: string,
    excludeId?: string
  ): void {
    const clash = entries.find(entry => entry.id !== excludeId && entry.localPath === localPath);
    if (clash) {
      throw new Error(`Repository already configured for path "${localPath}"`);
    }
  }

  // Name uniqueness is per-url (packet U1): the same name may exist for two
  // different Lore repos, but not twice within one url.
  private assertUniqueNameForUrl(
    entries: Repository[],
    url: string,
    name: string,
    excludeId?: string
  ): void {
    const clash = entries.find(
      entry =>
        entry.id !== excludeId &&
        entry.url === url &&
        entry.name.toLowerCase() === name.toLowerCase()
    );
    if (clash) {
      throw new Error(`Repository with name "${name}" already exists`);
    }
  }
}
