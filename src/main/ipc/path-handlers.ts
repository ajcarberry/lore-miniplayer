import * as path from 'node:path';
import { PathJoinInputSchema, PathBasenameInputSchema } from './validators';
import type { PathValidationResult } from '../../shared/types';
import { handleRequest } from './result-helpers';
import type { MainLogger } from './logger';

// Windows MAX_PATH constant (including null terminator)
const WINDOWS_MAX_PATH = 260;

/**
 * Validates a path for Windows compatibility
 * Checks for:
 * - Path length (MAX_PATH on Windows)
 * - Invalid characters
 * - Reserved names
 *
 * The platform is a parameter (defaulting to the host platform) so the
 * win32-only branches are testable on any host; win32 path semantics are
 * applied via path.win32 when validating for Windows.
 */
export function validateWindowsPath(
  inputPath: string,
  platform: typeof process.platform = process.platform
): PathValidationResult {
  if (platform !== 'win32') {
    return {
      valid: true,
      normalizedPath: path.normalize(inputPath),
    };
  }

  const normalizedPath = path.win32.normalize(inputPath);

  // Check path length
  if (normalizedPath.length >= WINDOWS_MAX_PATH) {
    return {
      valid: false,
      error: `Path exceeds Windows maximum length of ${WINDOWS_MAX_PATH} characters (current: ${normalizedPath.length})`,
    };
  }

  // Check for invalid characters (Windows-specific)
  const invalidChars = /[<>:"|?*]/;
  // Extract just the path components (not the drive letter)
  const pathWithoutDrive = normalizedPath.replace(/^[A-Za-z]:/, '');
  if (invalidChars.test(pathWithoutDrive)) {
    return {
      valid: false,
      error: 'Path contains invalid characters for Windows (< > : " | ? *)',
    };
  }

  // Check for reserved names in path components
  const reservedNames = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
  const components = pathWithoutDrive.split(path.win32.sep).filter(c => c.length > 0);
  for (const component of components) {
    // Remove extension for checking
    const nameWithoutExt = component.replace(/\.[^.]*$/, '');
    if (reservedNames.test(nameWithoutExt)) {
      return {
        valid: false,
        error: `Path contains reserved Windows name: ${component}`,
      };
    }
  }

  return {
    valid: true,
    normalizedPath,
  };
}

/**
 * Registers all path-related IPC handlers
 * These handlers provide cross-platform path operations to the renderer process
 */
export function registerPathIpcHandlers(log: MainLogger): void {
  // Joins path segments using the OS-specific separator, then validates the
  // result for Windows compatibility on Windows hosts.
  // Example: ['C:', 'Users', 'John', 'repos'] -> 'C:\Users\John\repos'
  handleRequest(log, 'path:join', PathJoinInputSchema, ({ segments }) => {
    const joinedPath = path.join(...segments);

    const validation = validateWindowsPath(joinedPath);
    if (!validation.valid) {
      throw new Error(validation.error || 'Path validation failed');
    }

    return joinedPath;
  });

  // Returns the last portion of a path (filename or directory name)
  // Example: 'C:\Users\John\repos\my-repo' -> 'my-repo'
  handleRequest(log, 'path:basename', PathBasenameInputSchema, input => path.basename(input.path));
}
