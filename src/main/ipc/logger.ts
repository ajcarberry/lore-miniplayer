// The main-process electron-log instance type, injected into every IPC
// handler group and service instead of each module bootstrapping its own.
export type MainLogger = typeof import('electron-log/main.js').default;
