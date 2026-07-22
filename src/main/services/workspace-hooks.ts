import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MainLogger } from '../ipc/logger';

// Claude Code observer hooks are written to the workspace's *local* settings
// so the plumbing never pollutes the branch the agent commits (research note:
// settings.local.json is gitignored, picked up on first launch, no trust
// prompt).
const CLAUDE_SETTINGS_REL = path.join('.claude', 'settings.local.json');

// The hook events the observer cares about (research note "Recommended
// shape"): session lifecycle, the task prompt, the waiting-on-you signal,
// turn completion, and live tool activity.
const OBSERVER_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'PostToolUse',
] as const;

// The seam P7 (the hook listener) fills: the loopback port it listens on and
// a per-workspace token embedded in each hook URL for authentication.
export interface WorkspaceObserverConfig {
  readonly port: number;
  readonly tokenForWorkspace: (workspacePath: string) => string;
}

// Write Claude Code observer hooks into the workspace's settings.local.json,
// deep-merging into any existing file so user content is never clobbered.
export async function writeObserverHooks(
  log: MainLogger,
  workspacePath: string,
  config: WorkspaceObserverConfig
): Promise<void> {
  const settingsPath = path.join(workspacePath, CLAUDE_SETTINGS_REL);

  // Never write observer plumbing through a symlinked `.claude` directory or
  // settings file: a symlink planted in the workspace could redirect the write
  // outside the worktree (e.g. clobber the user's global ~/.claude settings).
  // Both are checked with lstat (which does not follow the link).
  if ((await isSymlink(path.join(workspacePath, '.claude'))) || (await isSymlink(settingsPath))) {
    log.error('Refusing to write observer hooks through a symlinked settings path', {
      operation: 'workspace:writeObserverHooks',
      settingsPath,
    });
    return;
  }

  const token = config.tokenForWorkspace(workspacePath);
  const url = `http://127.0.0.1:${config.port}/hook/${token}`;
  const hookGroup = { hooks: [{ type: 'http', url }] };

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      // Unreadable/malformed existing file: never clobber it. Skip hook
      // injection and log — provisioning still succeeds, observability
      // degrades.
      log.error('Failed to read existing Claude settings; skipping observer hooks', {
        error,
        operation: 'workspace:writeObserverHooks',
        settingsPath,
      });
      return;
    }
  }

  const merged = mergeObserverHooks(existing, hookGroup);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
}

function mergeObserverHooks(
  existing: Record<string, unknown>,
  hookGroup: { hooks: Array<{ type: string; url: string }> }
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing };
  const existingHooks = existing['hooks'];
  const hooks: Record<string, unknown> =
    existingHooks && typeof existingHooks === 'object' && !Array.isArray(existingHooks)
      ? { ...(existingHooks as Record<string, unknown>) }
      : {};

  for (const event of OBSERVER_HOOK_EVENTS) {
    const current = hooks[event];
    const groups: unknown[] = Array.isArray(current) ? [...(current as unknown[])] : [];
    groups.push(hookGroup);
    hooks[event] = groups;
  }

  result['hooks'] = hooks;
  return result;
}

async function isSymlink(target: string): Promise<boolean> {
  const stats = await fs.lstat(target).catch(() => null);
  return stats?.isSymbolicLink() ?? false;
}
