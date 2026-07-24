import type { AgentTask } from '../../shared/types';

// Task status → glyph (design 2a/2b): done / running / pending. Shared by the
// Mission Control card and the review window's intention panel so the status
// vocabulary renders identically on both surfaces.
export const TASK_GLYPH: Record<AgentTask['status'], string> = {
  done: '✓',
  running: '▶',
  pending: '○',
};
