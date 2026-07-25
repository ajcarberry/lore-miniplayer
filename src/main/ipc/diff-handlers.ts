import type { DiffService } from '../services/diff-service';
import { IPC_CHANNELS, DiffRequestSchema } from '../../shared/schemas';
import { handleRequest } from './result-helpers';
import type { MainLogger } from './logger';

// The review window's compare picker (design 2b): diffs two CompareTargets
// (a revision, the working tree, or a branch's head). Re-validated at the
// boundary with the P2 DiffRequest contract.
export function registerDiffHandlers(log: MainLogger, diffService: DiffService): void {
  handleRequest(log, IPC_CHANNELS.diff.compare, DiffRequestSchema, request =>
    diffService.compare(request)
  );
}
