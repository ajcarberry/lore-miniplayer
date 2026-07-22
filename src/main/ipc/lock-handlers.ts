import type { LockService } from '../services/lock-service';
import { IPC_CHANNELS } from '../../shared/schemas';
import { handleResult } from './result-helpers';
import { LockQueryArgsSchema, LockReleaseArgsSchema } from './validators';
import type { MainLogger } from './logger';

// Lock visibility (spec "Supporting signals"): show who holds a lock and
// let the user release it — v1 never acquires/enforces locks. Each request
// is re-validated at the boundary with its P2 contract schema.
export function registerLockHandlers(log: MainLogger, lockService: LockService): void {
  handleResult(log, IPC_CHANNELS.locks.query, LockQueryArgsSchema, request =>
    lockService.query(request)
  );

  handleResult(log, IPC_CHANNELS.locks.release, LockReleaseArgsSchema, request =>
    lockService.release(request)
  );
}
