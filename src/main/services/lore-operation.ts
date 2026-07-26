import { lore } from '@lore-vcs/sdk';
import type { LoreFluentApi } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import * as path from 'node:path';
import { collectEvents } from './lore-events';
import type { LoreEventDataOf } from './lore-events';

// The shared SDK execution + error-wrapping scaffold every Lore-facing service
// uses: a typed per-service operation error, a run() that awaits a fluent
// operation, and a collect() that gathers its events — all wrapping failures
// into the service's own error class with a context message. Each service
// declares only its error subclass and derives the helpers from it.

// Base of the per-service operation errors.
export class OperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationError';
  }
}

type OperationErrorClass<E extends OperationError> = new (message: string) => E;

export interface OperationHelpers<E extends OperationError> {
  // Wraps any failure as the service's error class, passing an already-typed
  // error of that class through untouched.
  toOperationError(context: string, error: unknown): E;
  // Runs a fluent SDK operation, wrapping any failure.
  run(operation: LoreFluentApi, context: string): Promise<void>;
  // Runs a fluent SDK operation and collects the events matching `tag`,
  // wrapping any failure.
  collect<TTag extends LoreEventTag, T>(
    operation: LoreFluentApi,
    tag: TTag,
    map: (data: LoreEventDataOf<TTag>) => T | undefined,
    context: string
  ): Promise<T[]>;
}

export function operationHelpers<E extends OperationError>(
  ErrorClass: OperationErrorClass<E>
): OperationHelpers<E> {
  const toOperationError = (context: string, error: unknown): E => {
    if (error instanceof ErrorClass) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new ErrorClass(`${context}: ${message}`);
  };
  return {
    toOperationError,
    async run(operation: LoreFluentApi, context: string): Promise<void> {
      try {
        await operation.waitAsync();
      } catch (error) {
        throw toOperationError(context, error);
      }
    },
    collect<TTag extends LoreEventTag, T>(
      operation: LoreFluentApi,
      tag: TTag,
      map: (data: LoreEventDataOf<TTag>) => T | undefined,
      context: string
    ): Promise<T[]> {
      return collectEvents(operation, tag, map, error => toOperationError(context, error));
    },
  };
}

// The latest revision hash of a branch (its tip) via branchInfo, or undefined
// when the branch reports no revision. The caller decides how to treat an
// absent tip (degrade vs throw).
export async function branchTip<E extends OperationError>(
  helpers: OperationHelpers<E>,
  repositoryPath: string,
  branch: string,
  context: string
): Promise<string | undefined> {
  const infos = await helpers.collect(
    lore.branchInfo({ repositoryPath }, { branch }),
    LoreEventTag.BRANCH_INFO,
    (data: LoreEventDataOf<LoreEventTag.BRANCH_INFO>) => data.latest,
    context
  );
  return infos[infos.length - 1];
}

// The SDK resolves a relative path arg against the process CWD, NOT
// globalArgs.repositoryPath (see lore-handlers.ts for the same gotcha on
// fileStage). A repo-relative path such as 'Content/Caves/pass_1.txt' would
// otherwise become '<app-cwd>/Content/Caves/pass_1.txt' and the op rejects
// or silently PATH_IGNOREs it. Every path handed to an SDK op must be
// repo-absolute. Idempotent for a path that is already absolute.
export function toRepoAbsolutePath(repositoryPath: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(repositoryPath, filePath);
}

// Inverse of toRepoAbsolutePath: SDK ops echo back the (now absolute) path
// they were queried with, but the app/UI works only in repo-relative paths.
// Idempotent for a path that is already relative.
export function toRepoRelativePath(repositoryPath: string, filePath: string): string {
  return path.isAbsolute(filePath) ? path.relative(repositoryPath, filePath) : filePath;
}
