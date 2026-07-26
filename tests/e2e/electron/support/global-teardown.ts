import { reapSuiteElectron } from './reaper';

// Runs once after the whole test invocation. Final net beneath the fixture's
// bounded close: guarantees no suite Electron process outlives the run (scoped to
// APP_MAIN — see reaper.ts). The macOS window-restoration default written in
// setup is intentionally left in place — see macos-restore.ts.
export default function globalTeardown(): void {
  reapSuiteElectron();
}
