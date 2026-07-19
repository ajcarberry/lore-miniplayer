import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ConfigSchema, ConfigGetArgsSchema, ConfigSetArgsSchema } from './validators';
import type { ValidatedConfig, ValidatedWindowPosition } from './validators';
import { handleResult } from './result-helpers';
import type { MainLogger } from './logger';

const DEFAULT_CONFIG: ValidatedConfig = {
  themeMode: 'auto',
};

function getConfigFilePath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

// Reads the persisted config, falling back to defaults when nothing has been
// saved yet (or the file is unreadable/corrupt). Never throws.
async function readStoredConfig(log: MainLogger): Promise<ValidatedConfig> {
  try {
    const raw = await fs.readFile(getConfigFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return ConfigSchema.parse({ ...DEFAULT_CONFIG, ...parsed });
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return DEFAULT_CONFIG;
    }
    log.error('Failed to read configuration file', { error, operation: 'config:read' });
    return DEFAULT_CONFIG;
  }
}

async function writeStoredConfig(config: ValidatedConfig): Promise<void> {
  await fs.writeFile(getConfigFilePath(), JSON.stringify(config, null, 2), 'utf-8');
}

// Reads the persisted window position for the ambient player, or null if none
// has been saved. Called from the main process on launch (see index.ts) — the
// renderer never round-trips window geometry.
export async function loadWindowPosition(log: MainLogger): Promise<ValidatedWindowPosition | null> {
  const config = await readStoredConfig(log);
  return config.windowPosition ?? null;
}

// Persists the window's current top-left, merged into the existing config.
// Debounced by the caller (BrowserWindow 'move'/'moved' listener); never
// throws so a transient write failure can't crash the drag interaction.
export async function saveWindowPosition(
  position: ValidatedWindowPosition,
  log: MainLogger
): Promise<void> {
  try {
    const current = await readStoredConfig(log);
    await writeStoredConfig({ ...current, windowPosition: position });
  } catch (error) {
    log.error('Failed to save window position', { error, position, operation: 'window:position' });
  }
}

export function registerConfigHandlers(log: MainLogger): void {
  handleResult(log, 'config:get', ConfigGetArgsSchema, () => readStoredConfig(log));

  handleResult(log, 'config:set', ConfigSetArgsSchema, async update => {
    const current = await readStoredConfig(log);
    const next = ConfigSchema.parse({ ...current, ...update });
    await writeStoredConfig(next);
    return next;
  });
}
