import type { MergeService } from '../services/merge-service';
import { IPC_CHANNELS } from '../../shared/schemas';
import { handleResult } from './result-helpers';
import {
  MergeStartArgsSchema,
  MergeResolveArgsSchema,
  MergeAbortArgsSchema,
  MergeCompleteArgsSchema,
} from './validators';
import type { MainLogger } from './logger';

// The review window's merge workflow (design 2c, P13): start a merge of a
// branch toward main, resolve conflicts accept-mine/accept-theirs per file,
// abort to back out, or complete to land the merge (commit + push). Each
// request is re-validated at the boundary with its P2 schema.
export function registerMergeHandlers(log: MainLogger, mergeService: MergeService): void {
  handleResult(log, IPC_CHANNELS.merge.start, MergeStartArgsSchema, request =>
    mergeService.start(request)
  );

  handleResult(log, IPC_CHANNELS.merge.resolve, MergeResolveArgsSchema, request =>
    mergeService.resolve(request)
  );

  handleResult(log, IPC_CHANNELS.merge.abort, MergeAbortArgsSchema, request =>
    mergeService.abort(request)
  );

  handleResult(log, IPC_CHANNELS.merge.complete, MergeCompleteArgsSchema, request =>
    mergeService.complete(request)
  );
}
