import { reapSuiteElectron } from './reaper';
import { suppressMacWindowRestore } from './macos-restore';

// Runs once before the whole test invocation. Clears any suite Electron trees
// orphaned by a previously aborted run so this run's first firstWindow() starts
// against a clean process table (scoped to APP_MAIN — see reaper.ts), and disables
// the macOS "reopening windows" crash prompt for the dev Electron bundle so a
// force-killed wedged instance doesn't leave a dialog behind (see macos-restore.ts).
export default function globalSetup(): void {
  reapSuiteElectron();
  suppressMacWindowRestore();
}
