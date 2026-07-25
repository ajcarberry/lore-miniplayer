import type { MergeService } from '../services/merge-service';
import {
  IPC_CHANNELS,
  MergeStartRequestSchema,
  MergeResolveRequestSchema,
  MergeAbortRequestSchema,
  MergeCompleteRequestSchema,
} from '../../shared/schemas';
import { handleRequest } from './result-helpers';
import type { MainLogger } from './logger';

// The review window's merge workflow (design 2c, P13): start a merge of a
// branch toward main, resolve conflicts accept-mine/accept-theirs per file,
// abort to back out, or complete to land the merge (commit + push). Each
// request is re-validated at the boundary with its P2 schema.
export function registerMergeHandlers(log: MainLogger, mergeService: MergeService): void {
  handleRequest(log, IPC_CHANNELS.merge.start, MergeStartRequestSchema, request =>
    mergeService.start(request)
  );

  handleRequest(log, IPC_CHANNELS.merge.resolve, MergeResolveRequestSchema, request =>
    mergeService.resolve(request)
  );

  handleRequest(log, IPC_CHANNELS.merge.abort, MergeAbortRequestSchema, request =>
    mergeService.abort(request)
  );

  handleRequest(log, IPC_CHANNELS.merge.complete, MergeCompleteRequestSchema, request =>
    mergeService.complete(request)
  );
}
