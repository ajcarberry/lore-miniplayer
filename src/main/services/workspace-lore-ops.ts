import { LoreError } from '@lore-vcs/sdk';
import type { LoreFluentApi } from '@lore-vcs/sdk';
import type { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import { collectEvents } from './lore-events';
import type { LoreEventDataOf } from './lore-events';

// Generic Lore SDK execution + error-wrapping helpers shared by WorkspaceService
// operations (extracted so workspace-service.ts stays under the project's
// max-lines limit; decompose per eslint.config.js's size-limit guidance).

export class WorkspaceOperationError extends Error {
  constructor(
    message: string,
    public readonly errorType?: number
  ) {
    super(message);
    this.name = 'WorkspaceOperationError';
  }
}

export function toOperationError(context: string, error: unknown): WorkspaceOperationError {
  if (error instanceof WorkspaceOperationError) {
    return error;
  }
  if (error instanceof LoreError) {
    const firstError = error.loreErrors?.[0];
    return new WorkspaceOperationError(`${context}: ${error.message}`, firstError?.data.errorType);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new WorkspaceOperationError(`${context}: ${message}`);
}

// Runs a fluent SDK operation, wrapping any failure as a WorkspaceOperationError.
export async function run(operation: LoreFluentApi, context: string): Promise<void> {
  try {
    await operation.waitAsync();
  } catch (error) {
    throw toOperationError(context, error);
  }
}

// Runs a fluent SDK operation and collects the events matching `tag`, wrapping
// any failure as a WorkspaceOperationError.
export async function collect<TTag extends LoreEventTag, T>(
  operation: LoreFluentApi,
  tag: TTag,
  map: (data: LoreEventDataOf<TTag>) => T | undefined,
  context: string
): Promise<T[]> {
  return collectEvents(operation, tag, map, error => toOperationError(context, error));
}
