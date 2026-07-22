import type { DiffService } from '../services/diff-service';
import { IPC_CHANNELS } from '../../shared/schemas';
import { handleResult } from './result-helpers';
import { DiffCompareArgsSchema } from './validators';
import type { MainLogger } from './logger';

// The review window's compare picker (design 2b): diffs two CompareTargets
// (a revision, the working tree, or a branch's head). Re-validated at the
// boundary with the P2 DiffRequest contract.
export function registerDiffHandlers(log: MainLogger, diffService: DiffService): void {
  handleResult(log, IPC_CHANNELS.diff.compare, DiffCompareArgsSchema, request =>
    diffService.compare(request)
  );
}
