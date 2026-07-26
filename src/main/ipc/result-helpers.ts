import { ipcMain } from 'electron';
import { z } from 'zod';
import type { Result, VoidResult } from '../../shared/types';
import type { MainLogger } from './logger';

/**
 * Creates a successful result with data
 */
export function success<T>(data: T): Result<T> {
  return { success: true, data };
}

/**
 * Creates a successful void result (for operations that don't return data)
 */
export function voidSuccess(): VoidResult {
  return { success: true, data: undefined };
}

/**
 * Creates a failure result with an error message
 * Extracts clean error messages from various error types
 */
export function failure<T = never>(error: unknown): Result<T> {
  let errorMessage: string;

  if (error instanceof Error) {
    errorMessage = error.message;
  } else if (typeof error === 'string') {
    errorMessage = error;
  } else {
    errorMessage = 'An unexpected error occurred';
  }

  return { success: false, error: errorMessage };
}

/**
 * Registers an invoke-style IPC handler with the single Result<T> contract:
 * the handler's positional arguments are validated as a tuple with Zod
 * (safeParse — an invalid payload becomes a failure result carrying the
 * first issue's message, without reaching the operation), the operation's
 * return value is wrapped in success(), and a thrown error is logged with
 * the channel as the operation key and mapped to failure(). Handlers built
 * on this never throw across the IPC boundary.
 */
/**
 * Single-request-object convenience over handleResult: a channel that takes
 * exactly one request payload passes its contract schema directly, without
 * declaring a positional-tuple wrapper of its own.
 */
export function handleRequest<Req, T>(
  log: MainLogger,
  channel: string,
  schema: z.ZodType<Req>,
  op: (request: Req) => T | Promise<T>
): void {
  handleResult(log, channel, z.tuple([schema]), request => op(request));
}

export function handleResult<Args extends readonly unknown[], T>(
  log: MainLogger,
  channel: string,
  schema: z.ZodType<Args>,
  op: (...args: Args) => T | Promise<T>
): void {
  ipcMain.handle(channel, async (_event, ...rawArgs: unknown[]): Promise<Result<Awaited<T>>> => {
    const parsed = schema.safeParse(rawArgs);
    if (!parsed.success) {
      log.error(`Invalid ${channel} payload`, {
        error: parsed.error,
        rawArgs,
        operation: channel,
      });
      return failure(parsed.error.issues[0]?.message ?? 'Invalid request');
    }
    try {
      return success(await op(...parsed.data));
    } catch (error) {
      log.error(`${channel} failed`, { error, rawArgs, operation: channel });
      return failure(error);
    }
  });
}
