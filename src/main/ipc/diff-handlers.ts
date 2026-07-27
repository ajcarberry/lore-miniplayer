import type { DiffService } from '../services/diff-service';
import { DiffRequestSchema } from '../../shared/schemas';
import { handleRequest } from './result-helpers';
import type { MainLogger } from './logger';

// The Project View's compare picker: diffs two CompareTargets (a revision,
// the working tree, or a branch's head). Re-validated at the boundary with
// the DiffRequest contract.
export function registerDiffHandlers(log: MainLogger, diffService: DiffService): void {
  handleRequest(log, 'diff:compare', DiffRequestSchema, request => diffService.compare(request));
}
