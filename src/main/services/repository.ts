import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { MainLogger } from '../ipc/logger';
import type { Repository, RepositoryCreateInput, RepositoryUpdateInput } from '../../shared/types';
import {
  RepositorySchema,
  RepositoryCreateInputSchema,
  RepositoryUpdateInputSchema,
} from '../../shared/schemas';
import { ACCENT_HUE_VALUES } from '../../shared/accent';
import { z } from 'zod';

interface RepositoryStore {
  readonly repositories: Repository[];
  readonly version: string;
}

// Repositories stored before accentHue existed have no such field on disk;
// accept that shape on read and back-fill it (see backfillAccentHues below).
const StoredRepositorySchema = RepositorySchema.extend({
  accentHue: RepositorySchema.shape.accentHue.optional(),
});

const RepositoryStoreSchema = z.object({
  repositories: z.array(StoredRepositorySchema),
  version: z.string(),
});

type StoredRepository = z.infer<typeof StoredRepositorySchema>;

function accentHueForIndex(index: number): number {
  return ACCENT_HUE_VALUES[index % ACCENT_HUE_VALUES.length] as number;
}

function backfillAccentHues(entries: StoredRepository[]): {
  repositories: Repository[];
  changed: boolean;
} {
  let changed = false;
  const repositories = entries.map((entry, index) => {
    if (typeof entry.accentHue === 'number') {
      return entry as Repository;
    }
    changed = true;
    return { ...entry, accentHue: accentHueForIndex(index) };
  });
  return { repositories, changed };
}

export class RepositoryService {
  private readonly storePath: string;
  private repositories: Repository[] = [];
  private readonly STORE_VERSION = '1.0.0';

  constructor(private readonly log: MainLogger) {
    this.storePath = path.join(app.getPath('userData'), 'repositories.json');
  }

  async initialize(): Promise<void> {
    try {
      await this.load();
    } catch {
      await this.save();
    }
  }

  private async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.storePath, 'utf-8');
      const parsed = JSON.parse(data) as unknown;
      const validated = RepositoryStoreSchema.parse(parsed);
      const { repositories, changed } = backfillAccentHues(validated.repositories);
      this.repositories = repositories;
      if (changed) {
        await this.save();
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        this.repositories = [];
        await this.save();
      } else {
        this.log.error('Failed to load repositories', {
          error,
          storePath: this.storePath,
          operation: 'load',
        });
        throw new Error(
          `Failed to load repositories: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  private async save(): Promise<void> {
    const store: RepositoryStore = {
      repositories: this.repositories,
      version: this.STORE_VERSION,
    };

    const validated = RepositoryStoreSchema.parse(store);
    await fs.writeFile(this.storePath, JSON.stringify(validated, null, 2), 'utf-8');
  }

  async getAll(): Promise<Repository[]> {
    await this.load();
    return [...this.repositories];
  }

  async getById(id: string): Promise<Repository | null> {
    await this.load();
    return this.repositories.find(repo => repo.id === id) ?? null;
  }

  async create(input: RepositoryCreateInput): Promise<Repository> {
    const validatedInput = RepositoryCreateInputSchema.parse(input);

    await this.load();

    const existingName = this.repositories.find(
      repo => repo.name.toLowerCase() === validatedInput.name.toLowerCase()
    );
    if (existingName) {
      throw new Error(`Repository with name "${validatedInput.name}" already exists`);
    }

    const existingPath = this.repositories.find(
      repo => repo.localPath === validatedInput.localPath
    );
    if (existingPath) {
      throw new Error(`Repository already configured for path "${validatedInput.localPath}"`);
    }

    const now = new Date().toISOString();
    const accentHue = accentHueForIndex(this.repositories.length);
    const newRepository: Repository = {
      id: uuidv4() as string,
      name: validatedInput.name,
      url: validatedInput.url,
      localPath: validatedInput.localPath,
      accentHue,
      createdAt: now,
      updatedAt: now,
    };

    const validated = RepositorySchema.parse(newRepository);
    this.repositories.push(validated);
    await this.save();

    return validated;
  }

  async update(input: RepositoryUpdateInput): Promise<Repository> {
    const validatedInput = RepositoryUpdateInputSchema.parse(input);

    await this.load();

    const index = this.repositories.findIndex(repo => repo.id === validatedInput.id);
    if (index === -1) {
      throw new Error(`Repository with id "${validatedInput.id}" not found`);
    }

    const current = this.repositories[index];
    if (!current) {
      throw new Error(`Repository with id "${validatedInput.id}" not found`);
    }

    if (validatedInput.name) {
      const existingName = this.repositories.find(
        repo =>
          repo.id !== validatedInput.id &&
          repo.name.toLowerCase() === validatedInput.name?.toLowerCase()
      );
      if (existingName) {
        throw new Error(`Repository with name "${validatedInput.name}" already exists`);
      }
    }

    if (validatedInput.localPath) {
      const existingPath = this.repositories.find(
        repo => repo.id !== validatedInput.id && repo.localPath === validatedInput.localPath
      );
      if (existingPath) {
        throw new Error(`Repository already configured for path "${validatedInput.localPath}"`);
      }
    }

    const updated: Repository = {
      id: current.id,
      name: validatedInput.name ?? current.name,
      url: validatedInput.url ?? current.url,
      localPath: validatedInput.localPath ?? current.localPath,
      accentHue: validatedInput.accentHue ?? current.accentHue,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };

    const validated = RepositorySchema.parse(updated);
    this.repositories[index] = validated;
    await this.save();

    return validated;
  }

  async delete(id: string): Promise<void> {
    await this.load();

    const index = this.repositories.findIndex(repo => repo.id === id);
    if (index === -1) {
      throw new Error(`Repository with id "${id}" not found`);
    }

    this.repositories.splice(index, 1);
    await this.save();
  }
}
