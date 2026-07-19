import { lore } from '@lore-vcs/sdk';
import { LoreLogLevel } from '@lore-vcs/sdk/types/enums';
import { app } from 'electron';
import * as path from 'node:path';

let isInitialized = false;

// Route Lore SDK diagnostics to a rolling log in the user data directory
export function initializeLoreSdk(): void {
  if (isInitialized) {
    return;
  }

  lore.logConfigure({
    file: true,
    fileRolling: true,
    filePath: path.join(app.getPath('userData'), 'lore-logs'),
    level: LoreLogLevel.INFO,
  });
  isInitialized = true;
}

// Release the Lore SDK's native resources
export function shutdownLoreSdk(): void {
  if (!isInitialized) {
    return;
  }

  lore.shutdown();
  isInitialized = false;
}
