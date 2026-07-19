import type { LoreFluentApi } from '@lore-vcs/sdk';
import type { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import type { LoreEventFFITyped } from '@lore-vcs/sdk/types/events';

// The decoded payload of a cloned event for a given tag. `clone()` detaches
// the payload from the native FFI buffer, so mapped values may be retained
// past the callback tick.
export type LoreEventDataOf<TTag extends LoreEventTag> = ReturnType<
  LoreEventFFITyped<TTag>['clone']
>['data'];

// Runs a fluent SDK operation and collects the events matching `tag`,
// cloned and passed through `map`. Returning `undefined` from `map` skips
// an event. Failures are passed through `wrapError` when given, otherwise
// rethrown as-is (for callers that wrap or degrade at a higher level).
export async function collectEvents<TTag extends LoreEventTag, T>(
  operation: LoreFluentApi,
  tag: TTag,
  map: (data: LoreEventDataOf<TTag>) => T | undefined,
  wrapError?: (error: unknown) => Error
): Promise<T[]> {
  const results: T[] = [];
  try {
    await operation
      .callback(event => {
        if (event.tag === tag) {
          const mapped = map((event as LoreEventFFITyped<TTag>).clone().data);
          if (mapped !== undefined) {
            results.push(mapped);
          }
        }
      })
      .waitAsync();
  } catch (error) {
    throw wrapError ? wrapError(error) : error;
  }
  return results;
}
