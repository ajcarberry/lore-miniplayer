import { reapSuiteElectron } from './reaper';
import { restoreMacWindowRestore } from './macos-restore';

// Runs once after the whole test invocation. Final net beneath the fixture's
// bounded close: guarantees no suite Electron process outlives the run (scoped to
// APP_MAIN — see reaper.ts), and restores the macOS window-restoration default so
// the suite leaves no lasting machine change (see macos-restore.ts).
export default function globalTeardown(): void {
  reapSuiteElectron();
  restoreMacWindowRestore();
}
