// Mock electron module before imports
jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn(),
  },
  BrowserWindow: jest.fn(),
  dialog: jest.fn(),
  shell: jest.fn(),
  app: {
    getPath: jest.fn(),
  },
}));

// Mock electron-log as a module with default export
const mockLog = {
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  log: jest.fn(),
  verbose: jest.fn(),
  debug: jest.fn(),
};

jest.mock('electron-log/main.js', () => ({
  __esModule: true,
  default: mockLog,
}));

import * as path from 'node:path';
import { ipcMain } from 'electron';
import log from 'electron-log/main.js';
import { registerPathIpcHandlers, validateWindowsPath } from '../../../src/main/ipc/path-handlers';
import type { Result } from '../../../src/shared/types';

describe('Path IPC Handlers', () => {
  // Store registered handlers
  const handlers = new Map<string, Function>();
  const mockIpcMain = ipcMain as jest.Mocked<typeof ipcMain>;

  beforeAll(() => {
    // Mock ipcMain.handle to capture handler registrations
    mockIpcMain.handle.mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });

    registerPathIpcHandlers(log);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('path:join', () => {
    it('should join path segments with OS-specific separator', async () => {
      // Given: Multiple path segments
      const handler = handlers.get('path:join')!;
      const input = { segments: ['C:', 'Users', 'John', 'repos'] };

      // When: Handler is called
      const result = (await handler(null, input)) as Result<string>;

      // Then: Path is joined correctly with the host's separator
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(['C:', 'Users', 'John', 'repos'].join(path.sep));
      }
    });

    it('should validate the resulting path against the host platform', async () => {
      // Given: Path segments that would exceed MAX_PATH on Windows
      const handler = handlers.get('path:join')!;
      const longSegment = 'a'.repeat(300);
      const input = { segments: ['C:', longSegment] };

      // When: Handler is called
      const result = (await handler(null, input)) as Result<string>;

      // Then: it fails validation on Windows hosts and passes elsewhere
      // (win32 branches are asserted unconditionally in the
      // validateWindowsPath suite below)
      if (process.platform === 'win32') {
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('maximum length');
        }
      } else {
        expect(result.success).toBe(true);
      }
    });

    it('should handle empty segments array', async () => {
      // Given: Empty segments array
      const handler = handlers.get('path:join')!;
      const input = { segments: [] };

      // When: Handler is called
      const result = (await handler(null, input)) as Result<string>;

      // Then: Should return failure
      expect(result.success).toBe(false);
    });

    it('should handle invalid input schema', async () => {
      // Given: Invalid input (not an object with segments)
      const handler = handlers.get('path:join')!;
      const input = { invalid: 'data' };

      // When: Handler is called
      const result = (await handler(null, input)) as Result<string>;

      // Then: Should return failure
      expect(result.success).toBe(false);
    });
  });

  describe('path:basename', () => {
    it('should extract filename from Unix path', async () => {
      if (process.platform === 'win32') {
        return; // Skip Unix path tests on Windows
      }

      // Given: A Unix-style path
      const handler = handlers.get('path:basename')!;
      const input = { path: '/Users/john/repos/my-repo' };

      // When: Handler is called
      const result = (await handler(null, input)) as Result<string>;

      // Then: Should return the basename
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('my-repo');
      }
    });

    it('should extract filename from Windows path', async () => {
      if (process.platform !== 'win32') {
        return; // Skip Windows path tests on non-Windows platforms
      }

      // Given: A Windows-style path
      const handler = handlers.get('path:basename')!;
      const input = { path: 'C:\\Users\\John\\repos\\my-repo' };

      // When: Handler is called
      const result = (await handler(null, input)) as Result<string>;

      // Then: Should return the basename
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('my-repo');
      }
    });

    it('should handle path with file extension', async () => {
      // Given: A path with file extension
      const handler = handlers.get('path:basename')!;
      const input = { path: '/path/to/file.txt' };

      // When: Handler is called
      const result = (await handler(null, input)) as Result<string>;

      // Then: Should return full filename with extension
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('file.txt');
      }
    });
  });
});

// The platform is passed explicitly so the win32-only validation branches
// are asserted unconditionally on every host.
describe('validateWindowsPath', () => {
  it('should accept a normal path and return its win32-normalized form', () => {
    // When: validating a well-formed path for win32
    const result = validateWindowsPath('C:\\Users\\John\\repos', 'win32');

    // Then: it is valid with a normalized path
    expect(result).toEqual({ valid: true, normalizedPath: 'C:\\Users\\John\\repos' });
  });

  it('should reject a path at or beyond MAX_PATH', () => {
    // Given: a path of exactly 260 characters after normalization
    const longPath = `C:\\${'a'.repeat(257)}`;

    // When: validating for win32
    const result = validateWindowsPath(longPath, 'win32');

    // Then: it is rejected with the length error
    expect(result.valid).toBe(false);
    expect(result.error).toContain('maximum length');
  });

  it('should accept a path just under MAX_PATH', () => {
    // Given: a path of 259 characters after normalization
    const longPath = `C:\\${'a'.repeat(256)}`;

    // When: validating for win32
    const result = validateWindowsPath(longPath, 'win32');

    // Then: it is accepted
    expect(result.valid).toBe(true);
  });

  it('should accept an over-long path on non-Windows platforms', () => {
    // When: validating a 300-character path for a POSIX platform
    const result = validateWindowsPath(`/tmp/${'a'.repeat(300)}`, 'darwin');

    // Then: no Windows limit applies
    expect(result.valid).toBe(true);
  });

  it('should reject invalid Windows characters in path components', () => {
    // When: validating a path with a '<' in a component
    const result = validateWindowsPath('C:\\Users\\bad<name\\file.txt', 'win32');

    // Then: it is rejected with the invalid-character error
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid characters');
  });

  it('should not treat the drive-letter colon as an invalid character', () => {
    // When: validating a drive-qualified path for win32
    const result = validateWindowsPath('C:\\Users\\ok.txt', 'win32');

    // Then: the drive colon does not trip the invalid-character check
    expect(result.valid).toBe(true);
  });

  it('should reject reserved Windows device names, including with an extension', () => {
    // When: validating paths containing CON as a component and aux with an extension
    const bareReserved = validateWindowsPath('C:\\logs\\CON\\out.txt', 'win32');
    const reservedWithExt = validateWindowsPath('C:\\logs\\aux.txt', 'win32');

    // Then: both are rejected with the reserved-name error
    expect(bareReserved.valid).toBe(false);
    expect(bareReserved.error).toContain('reserved Windows name');
    expect(reservedWithExt.valid).toBe(false);
    expect(reservedWithExt.error).toContain('reserved Windows name');
  });

  it('should reject LPT and COM variations', () => {
    // When: validating paths containing numbered device names
    const lpt = validateWindowsPath('C:\\print\\LPT1', 'win32');
    const com = validateWindowsPath('C:\\ports\\com9.log', 'win32');

    // Then: both numbered device names are rejected
    expect(lpt.valid).toBe(false);
    expect(lpt.error).toContain('reserved Windows name');
    expect(com.valid).toBe(false);
    expect(com.error).toContain('reserved Windows name');
  });

  it('should accept names that merely start with a reserved name', () => {
    // When: validating lookalike component names
    const result = validateWindowsPath('C:\\Users\\console.txt', 'win32');

    // Then: 'console' is not a reserved device name
    expect(result.valid).toBe(true);
  });

  it('should accept reserved-looking names on non-Windows platforms', () => {
    // When: validating a path containing 'con' for a POSIX platform
    const result = validateWindowsPath('/tmp/con/file.txt', 'linux');

    // Then: no Windows reserved-name rule applies
    expect(result).toEqual({ valid: true, normalizedPath: '/tmp/con/file.txt' });
  });
});
