// electron-log is loaded lazily so the renderer bundle stays lean; callers
// use logError which is a no-op until the logger has loaded
let log: typeof import('electron-log/renderer.js') | undefined;

void import('electron-log/renderer.js').then(module => {
  log = module.default;
});

function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return error.stack
      ? { message: error.message, stack: error.stack }
      : { message: error.message };
  }
  return { message: String(error) };
}

export function logError(message: string, context: Record<string, unknown>): void {
  const { error, ...rest } = context;
  log?.error(message, { ...rest, error: serializeError(error) });
}
