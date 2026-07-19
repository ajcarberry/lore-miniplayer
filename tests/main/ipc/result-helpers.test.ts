type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const registeredHandlers = new Map<string, IpcHandler>();

jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn((channel: string, handler: IpcHandler) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

jest.mock('electron-log/main.js', () => ({
  __esModule: true,
  default: { error: jest.fn(), initialize: jest.fn() },
}));

import { z } from 'zod';
import log from 'electron-log/main.js';
import { success, voidSuccess, failure, handleResult } from '../../../src/main/ipc/result-helpers';

describe('result-helpers', () => {
  describe('success', () => {
    it('should wrap data in a successful result', () => {
      // Given: some payload data
      const data = { name: 'repo', count: 2 };

      // When: wrapping it
      const result = success(data);

      // Then: the result is successful and carries the data
      expect(result).toEqual({ success: true, data });
    });
  });

  describe('voidSuccess', () => {
    it('should produce a successful result with no data', () => {
      // When: creating a void success
      const result = voidSuccess();

      // Then: the result is successful with undefined data
      expect(result).toEqual({ success: true, data: undefined });
    });
  });

  describe('failure', () => {
    it('should extract the message from an Error', () => {
      // Given: an Error instance
      const error = new Error('disk on fire');

      // When: converting to a failure result
      const result = failure(error);

      // Then: the message is extracted
      expect(result).toEqual({ success: false, error: 'disk on fire' });
    });

    it('should pass through string errors', () => {
      // When: converting a plain string
      const result = failure('bad input');

      // Then: the string is used as-is
      expect(result).toEqual({ success: false, error: 'bad input' });
    });

    it('should fall back to a generic message for unknown values', () => {
      // When: converting a non-Error, non-string value
      const result = failure({ code: 42 });

      // Then: a generic message is used
      expect(result).toEqual({ success: false, error: 'An unexpected error occurred' });
    });
  });

  describe('handleResult', () => {
    const argsSchema = z.tuple([z.string('Invalid name')]);

    function invoke(channel: string, ...args: unknown[]): unknown {
      const handler = registeredHandlers.get(channel);
      if (!handler) {
        throw new Error(`No handler registered for ${channel}`);
      }
      return handler(undefined, ...args);
    }

    beforeEach(() => {
      registeredHandlers.clear();
      jest.clearAllMocks();
    });

    it('should wrap the operation return value in a success result', async () => {
      // Given: a registered handler whose op echoes its argument
      handleResult(log, 'test:echo', argsSchema, async name => `hello ${name}`);

      // When: invoking with a valid payload
      const result = await invoke('test:echo', 'world');

      // Then: the op result is wrapped
      expect(result).toEqual({ success: true, data: 'hello world' });
    });

    it('should reject an invalid payload with the schema message and log it', async () => {
      // Given: a registered handler with a spy op
      const op = jest.fn();
      handleResult(log, 'test:echo', argsSchema, op);

      // When: invoking with a non-string payload
      const result = await invoke('test:echo', 42);

      // Then: validation fails before the op runs, with the channel as the
      // logged operation key
      expect(result).toEqual({ success: false, error: 'Invalid name' });
      expect(op).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        'Invalid test:echo payload',
        expect.objectContaining({ operation: 'test:echo' })
      );
    });

    it('should convert a thrown operation error into a failure result and log it', async () => {
      // Given: an op that throws
      handleResult(log, 'test:echo', argsSchema, async (_name: string) => {
        throw new Error('kaboom');
      });

      // When: invoking with a valid payload
      const result = await invoke('test:echo', 'world');

      // Then: the error surfaces as a failure result and is logged with the
      // channel as the operation key
      expect(result).toEqual({ success: false, error: 'kaboom' });
      expect(log.error).toHaveBeenCalledWith(
        'test:echo failed',
        expect.objectContaining({ operation: 'test:echo' })
      );
    });
  });
});
