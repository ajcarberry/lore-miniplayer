import { reapSuiteElectron } from './reaper';

// Runs once before the whole test invocation. Clears any suite Electron trees
// orphaned by a previously aborted run so this run's first firstWindow() starts
// against a clean process table. Scoped to APP_MAIN — see reaper.ts.
export default function globalSetup(): void {
  reapSuiteElectron();
}
