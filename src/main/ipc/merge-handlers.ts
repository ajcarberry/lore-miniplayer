import type { MergeService } from '../services/merge-service';
import {
  MergeStartRequestSchema,
  MergeResolveRequestSchema,
  MergeAbortRequestSchema,
  MergeCompleteRequestSchema,
} from '../../shared/schemas';
import { handleRequest } from './result-helpers';
import type { MainLogger } from './logger';

// The Project View's merge workflow: start a merge of a branch toward its
// target, resolve conflicts accept-mine/accept-theirs per file, abort to back
// out, or complete to land the merge (commit + push). Each request is
// re-validated at the boundary with its schema.
export function registerMergeHandlers(log: MainLogger, mergeService: MergeService): void {
  handleRequest(log, 'merge:start', MergeStartRequestSchema, request =>
    mergeService.start(request)
  );

  handleRequest(log, 'merge:resolve', MergeResolveRequestSchema, request =>
    mergeService.resolve(request)
  );

  handleRequest(log, 'merge:abort', MergeAbortRequestSchema, request =>
    mergeService.abort(request)
  );

  handleRequest(log, 'merge:complete', MergeCompleteRequestSchema, request =>
    mergeService.complete(request)
  );
}
