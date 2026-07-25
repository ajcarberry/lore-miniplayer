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

// The placeholder url the attach-existing-folder flow records before the true
// Lore identity is resolved (the renderer has no SDK access). Post-unification
// url is the grouping key for "same Lore repo", so this placeholder must be
// replaced with the checkout's real identity — at create time, and (for entries
// written by the pre-fix flow) by a heal pass on load. Kept in sync with the
// renderer literal in useRepositorySubmission.ts.
const LOCAL_EXISTING_URL = 'local://existing';

// Resolves a checkout's true Lore identity from its on-disk `.lore/` config.
// LoreRepositoryService satisfies this; injecting the narrow shape keeps the
// registry service decoupled from the SDK surface (and optional in tests).
export interface RepositoryIdentityResolver {
  resolveRepositoryIdentity(
    repositoryPath: string
  ): Promise<{ url: string; loreRepositoryId?: string } | undefined>;
}

// Manages card-view repositories, persisted in the unified workspace registry
// (`workspaces.json`, packet U1). The public API is unchanged from the legacy
// repository store — create/update/delete/getAll/getById — but every entry now
// carries the unified shape (with `origin`), uniqueness on name is scoped
// per-url (branch-named provisioned entries repeat across repos), and `delete`
// is a non-destructive "forget" for ALL origins.
export class RepositoryService {
  private readonly registry: WorkspaceRegistry;

  constructor(
    private readonly log: MainLogger,
    // Optional so tests (and any SDK-less bootstrap) construct without it; when
    // absent, attach records the url as given and heal is skipped.
    private readonly identityResolver?: RepositoryIdentityResolver,
    // Injected in production (index.ts) so this service and WorkspaceService
    // share ONE registry instance — serializing their read-modify-write
    // cycles through the same queue (C56). Optional so tests construct as
    // before.
    registry?: WorkspaceRegistry
  ) {
    this.registry = registry ?? new WorkspaceRegistry(log);
  }

  async initialize(): Promise<void> {
    // Triggers migration from the legacy repositories.json when one lingers;
    // idempotent across restarts.
    await this.registry.all();
    // Repair placeholder-url attach entries written by the pre-fix flow, and
    // backfill any entry missing its loreRepositoryId, so they group with their
    // true Lore repo on next launch (non-fatal per entry, logged).
    await this.healRegistryIdentities();
  }

  // `includeProvisioned` surfaces every registry origin (U2: the card-view
  // selector lists all workspaces, provisioned worktrees included); omitted
  // keeps the default card-view-only list unchanged for existing callers.
  async getAll(includeProvisioned = false): Promise<Repository[]> {
    const entries = await this.registry.all();
    if (includeProvisioned) {
      return entries;
    }
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

    // The attach flow records a `local://existing` placeholder (the renderer
    // cannot reach the SDK); resolve the checkout's true identity here so the
    // url grouping key is correct from the start. Never blocks attach: an
    // unresolvable checkout keeps the placeholder and heals on a later launch.
    const resolved = await this.resolveIfPlaceholder(validatedInput.url, validatedInput.localPath);

    const entries = await this.registry.all();
    this.assertUniqueLocalPath(entries, validatedInput.localPath);
    this.assertUniqueNameForUrl(entries, resolved.url, validatedInput.name);

    const now = new Date().toISOString();
    const newRepository = RepositorySchema.parse({
      id: uuidv4() as string,
      name: validatedInput.name,
      url: resolved.url,
      ...(resolved.loreRepositoryId ? { loreRepositoryId: resolved.loreRepositoryId } : {}),
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

  // --- identity resolution ---------------------------------------------------

  // Resolve the true url + id for a placeholder-url attach; any other url is
  // returned untouched (already truthful). Failure degrades to the input url
  // with no id — attach must never be blocked on SDK reachability.
  private async resolveIfPlaceholder(
    url: string,
    localPath: string
  ): Promise<{ url: string; loreRepositoryId?: string }> {
    if (url !== LOCAL_EXISTING_URL) {
      return { url };
    }
    const resolved = await this.tryResolveIdentity(localPath);
    return resolved ?? { url };
  }

  // Attempt identity resolution, swallowing every failure into `undefined` so
  // callers (create + heal) degrade rather than throw. Logged for diagnostics.
  private async tryResolveIdentity(
    localPath: string
  ): Promise<{ url: string; loreRepositoryId?: string } | undefined> {
    if (!this.identityResolver) {
      return undefined;
    }
    try {
      return await this.identityResolver.resolveRepositoryIdentity(localPath);
    } catch (error) {
      this.log.warn('Failed to resolve Lore repository identity (keeping placeholder url)', {
        error,
        localPath,
        operation: 'repository:resolve-identity',
      });
      return undefined;
    }
  }

  // Heal registry identities on load, in place, for ALL origins:
  //   - a `local://existing` placeholder url adopts its resolved true url; and
  //   - any entry missing its `loreRepositoryId` gets it backfilled.
  // Idempotent (a truthful url that already has its id is skipped, and a write
  // only happens when something actually changed) and non-fatal per entry (an
  // unresolvable one is left unchanged and retried next launch).
  private async healRegistryIdentities(): Promise<void> {
    if (!this.identityResolver) {
      return;
    }
    const entries = await this.registry.all();
    for (const entry of entries) {
      const isPlaceholder = entry.url === LOCAL_EXISTING_URL;
      const missingId = entry.loreRepositoryId === undefined;
      // Nothing to do: a truthful url that already carries its id.
      if (!isPlaceholder && !missingId) {
        continue;
      }
      const resolved = await this.tryResolveIdentity(entry.localPath);
      if (!resolved) {
        continue;
      }
      // A placeholder adopts the resolved url; a truthful url is kept. A
      // missing id is backfilled; an already-present id is never overwritten.
      const nextUrl = isPlaceholder ? resolved.url : entry.url;
      const nextId = entry.loreRepositoryId ?? resolved.loreRepositoryId;
      // Skip a no-op write (e.g. a truthful entry whose id could not resolve).
      if (nextUrl === entry.url && nextId === entry.loreRepositoryId) {
        continue;
      }
      const healed: Repository = {
        ...entry,
        url: nextUrl,
        ...(nextId ? { loreRepositoryId: nextId } : {}),
        updatedAt: new Date().toISOString(),
      };
      await this.registry.upsertById(healed);
      this.log.info('Healed workspace identity to its true Lore repository', {
        operation: 'repository:heal-identity',
        localPath: entry.localPath,
        url: nextUrl,
        ...(nextId ? { loreRepositoryId: nextId } : {}),
      });
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
