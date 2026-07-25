import { reapSuiteElectron } from './reaper';

// Runs once after the whole test invocation. Final net beneath the fixture's
// bounded close: guarantees no suite Electron process outlives the run. Scoped
// to APP_MAIN — see reaper.ts.
export default function globalTeardown(): void {
  reapSuiteElectron();
}
