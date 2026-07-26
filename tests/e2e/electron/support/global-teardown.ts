import { reapSuiteElectron } from './reaper';

// Runs once after the whole test invocation: guarantees no suite Electron
// process outlives the run (scoped to APP_MAIN — see reaper.ts). The macOS
// restore key written in setup is deliberately left set (see macos-restore.ts).
export default function globalTeardown(): void {
  reapSuiteElectron();
}
