import type { ElectronAPI } from '../main/preload';

// The renderer's view of the preload bridge. Derived from the preload's own
// `api` object (`typeof api`) so the contract is declared exactly once and
// cannot drift from what contextBridge actually exposes.
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
