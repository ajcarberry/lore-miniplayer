import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentTranscriptService } from '../../../src/main/services/agent-transcript';
import type { MainLogger } from '../../../src/main/ipc/logger';
import { AgentIntentionSchema } from '../../../src/shared/schemas';

// electron-log stand-in: the service only ever logs paths/counts/lines, never
// content — asserted explicitly below.
const mockLog = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};
const logger = mockLog as unknown as MainLogger;

// The hand-authored, sanitized realistic fixture (never copied from a real
// transcript) plus its sibling tasks directory.
const FIXTURE_DIR = path.join(__dirname, '../../mocks/transcripts');
const REALISTIC_TRANSCRIPT = path.join(FIXTURE_DIR, 'session-fixture.jsonl');
const TASKS_ROOT = path.join(FIXTURE_DIR, 'tasks');
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FLAG_ENV = 'LORE_MINIPLAYER_TRANSCRIPT_ENRICHMENT';

// The newest assistant record in the fixture is stamped 10:06:00; a fixed
// clock 30s later makes runningElapsedMs deterministic.
const NEWEST_ASSISTANT_MS = Date.parse('2026-07-22T10:06:00.000Z');
const FIXED_NOW = NEWEST_ASSISTANT_MS + 30_000;

function newService(overrides: Record<string, unknown> = {}): AgentTranscriptService {
  return new AgentTranscriptService(logger, {
    enabled: true,
    tasksRoot: TASKS_ROOT,
    now: () => FIXED_NOW,
    ...overrides,
  });
}

describe('AgentTranscriptService', () => {
  let tmpBase: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-transcript-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  describe('full extraction from a realistic fixture', () => {
    it('extracts prompt, title, tasks, commentary, and summary', async () => {
      // Given: a realistic transcript + tasks dir
      // When: extracting
      const intention = await newService().extract(REALISTIC_TRANSCRIPT);

      // Then: every derived field matches the fixture
      expect(intention.prompt).toBe('Add a dark mode toggle to the settings panel.');
      expect(intention.title).toBe('Add dark mode toggle to settings');
      expect(intention.sessionId).toBe(SESSION_ID);
      expect(intention.summary).toBe(
        'Done. The toggle persists via config and both themes render correctly.'
      );
      // costUsd is never present in transcripts
      expect(intention.costUsd).toBeUndefined();

      // The output is a valid AgentIntention (P2 schema)
      expect(() => AgentIntentionSchema.parse(intention)).not.toThrow();
    });

    it('maps tasks by status and computes runningElapsedMs only for the running task', async () => {
      const { tasks } = await newService().extract(REALISTIC_TRANSCRIPT);

      expect(tasks).toEqual([
        { subject: 'Locate the settings panel component', status: 'done' },
        {
          subject: 'Add the dark mode toggle control',
          status: 'running',
          runningElapsedMs: 30_000,
        },
        { subject: 'Persist the theme choice across restarts', status: 'pending' },
      ]);
    });

    it('collects assistant text blocks as commentary and excludes thinking blocks', async () => {
      const { commentary } = await newService().extract(REALISTIC_TRANSCRIPT);

      const texts = commentary.map(c => c.text);
      expect(texts).toEqual([
        "I'll start by locating the settings panel component.",
        'Added the toggle control and wired it to the theme store.',
        'Wired persistence through the config store.',
        'Done. The toggle persists via config and both themes render correctly.',
      ]);
      // thinking content must never leak
      expect(texts.some(t => t.includes('internal reasoning'))).toBe(false);
      // timestamps are epoch ms in ascending order
      expect(commentary[0]?.at).toBe(Date.parse('2026-07-22T10:00:05.000Z'));
      expect(commentary.every(c => Number.isFinite(c.at))).toBe(true);
    });

    it('never logs transcript content (only paths/counts)', async () => {
      await newService().extract(REALISTIC_TRANSCRIPT);
      const allLogged = [mockLog.debug, mockLog.info, mockLog.warn, mockLog.error]
        .flatMap(fn => (fn as jest.Mock).mock.calls)
        .map(args => JSON.stringify(args))
        .join(' ');
      expect(allLogged).not.toContain('dark mode');
      expect(allLogged).not.toContain('internal reasoning');
    });
  });

  describe('defensive parsing', () => {
    it('skips corrupt lines and still extracts from the valid ones', async () => {
      const file = path.join(tmpBase, 'corrupt.jsonl');
      await fsp.writeFile(
        file,
        [
          '{ this is not valid json',
          JSON.stringify({
            type: 'user',
            sessionId: 's1',
            timestamp: '2026-07-22T10:00:00.000Z',
            message: { role: 'user', content: 'Fix the flaky test.' },
          }),
          'null-terminated-garbage}}}',
          JSON.stringify({
            type: 'assistant',
            sessionId: 's1',
            timestamp: '2026-07-22T10:00:01.000Z',
            message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
          }),
        ].join('\n'),
        'utf8'
      );

      const intention = await newService({ tasksRoot: tmpBase }).extract(file);

      expect(intention.prompt).toBe('Fix the flaky test.');
      expect(intention.commentary.map(c => c.text)).toEqual(['On it.']);
      expect(() => AgentIntentionSchema.parse(intention)).not.toThrow();
    });

    it('ignores unknown record types', async () => {
      const file = path.join(tmpBase, 'unknown.jsonl');
      await fsp.writeFile(
        file,
        [
          JSON.stringify({ type: 'mode', mode: 'plan' }),
          JSON.stringify({ type: 'pr-link', prNumber: 7, prUrl: 'x', prRepository: 'y' }),
          JSON.stringify({ type: 'brand-new-record-type', whatever: true }),
          JSON.stringify({
            type: 'user',
            sessionId: 's2',
            timestamp: '2026-07-22T10:00:00.000Z',
            message: { role: 'user', content: 'Only this counts.' },
          }),
        ].join('\n'),
        'utf8'
      );

      const intention = await newService({ tasksRoot: tmpBase }).extract(file);
      expect(intention.prompt).toBe('Only this counts.');
    });

    it('returns a typed empty result for a missing file (never throws)', async () => {
      const intention = await newService().extract(path.join(tmpBase, 'does-not-exist.jsonl'));
      expect(intention).toEqual({ tasks: [], commentary: [] });
    });

    it('returns a typed empty result for an empty file', async () => {
      const file = path.join(tmpBase, 'empty.jsonl');
      await fsp.writeFile(file, '', 'utf8');
      const intention = await newService({ tasksRoot: tmpBase }).extract(file);
      expect(intention).toEqual({ tasks: [], commentary: [] });
    });

    it('falls back to the last-prompt record when there is no plain user prompt', async () => {
      const file = path.join(tmpBase, 'no-user-prompt.jsonl');
      await fsp.writeFile(
        file,
        [
          JSON.stringify({
            type: 'user',
            isMeta: true,
            sessionId: 's3',
            timestamp: '2026-07-22T10:00:00.000Z',
            message: { role: 'user', content: 'meta only' },
          }),
          JSON.stringify({
            type: 'last-prompt',
            sessionId: 's3',
            timestamp: '2026-07-22T10:01:00.000Z',
            lastPrompt: 'Recovered from the sidecar record.',
          }),
        ].join('\n'),
        'utf8'
      );

      const intention = await newService({ tasksRoot: tmpBase }).extract(file);
      expect(intention.prompt).toBe('Recovered from the sidecar record.');
    });
  });

  describe('tasks directory', () => {
    it('tolerates a missing tasks directory (no tasks, no throw)', async () => {
      const file = path.join(tmpBase, 'session.jsonl');
      await fsp.writeFile(
        file,
        JSON.stringify({
          type: 'user',
          sessionId: 'no-such-session',
          timestamp: '2026-07-22T10:00:00.000Z',
          message: { role: 'user', content: 'hi' },
        }),
        'utf8'
      );

      const intention = await newService({ tasksRoot: tmpBase }).extract(file);
      expect(intention.tasks).toEqual([]);
    });
  });

  describe('commentary cap', () => {
    it('keeps only the newest 20 commentary entries, in chronological order', async () => {
      const lines: string[] = [];
      for (let i = 0; i < 25; i += 1) {
        const minute = String(i).padStart(2, '0');
        lines.push(
          JSON.stringify({
            type: 'assistant',
            sessionId: 's4',
            timestamp: `2026-07-22T10:${minute}:00.000Z`,
            message: { role: 'assistant', content: [{ type: 'text', text: `step ${i}` }] },
          })
        );
      }
      const file = path.join(tmpBase, 'many.jsonl');
      await fsp.writeFile(file, lines.join('\n'), 'utf8');

      const { commentary } = await newService({ tasksRoot: tmpBase }).extract(file);
      expect(commentary).toHaveLength(20);
      // newest 20 => steps 5..24, chronological
      expect(commentary[0]?.text).toBe('step 5');
      expect(commentary[19]?.text).toBe('step 24');
    });
  });

  describe('feature flag', () => {
    it('returns the typed empty result when disabled', async () => {
      const intention = await newService({ enabled: false }).extract(REALISTIC_TRANSCRIPT);
      expect(intention).toEqual({ tasks: [], commentary: [] });
    });

    it('defaults ON from the environment when `enabled` is not passed', async () => {
      const prior = process.env[FLAG_ENV];
      delete process.env[FLAG_ENV];
      try {
        // No `enabled` option => resolved from env (unset => ON). Default
        // tasksRoot points at ~/.claude/tasks (no fixture there) => no tasks.
        const service = new AgentTranscriptService(logger, {});
        const intention = await service.extract(REALISTIC_TRANSCRIPT);
        expect(intention.prompt).toBe('Add a dark mode toggle to the settings panel.');
        expect(intention.tasks).toEqual([]);
      } finally {
        if (prior === undefined) delete process.env[FLAG_ENV];
        else process.env[FLAG_ENV] = prior;
      }
    });

    it('is disabled by the environment flag when `enabled` is not passed', async () => {
      const prior = process.env[FLAG_ENV];
      process.env[FLAG_ENV] = 'off';
      try {
        const service = new AgentTranscriptService(logger, {});
        const intention = await service.extract(REALISTIC_TRANSCRIPT);
        expect(intention).toEqual({ tasks: [], commentary: [] });
      } finally {
        if (prior === undefined) delete process.env[FLAG_ENV];
        else process.env[FLAG_ENV] = prior;
      }
    });
  });

  describe('bounded reads and further edge cases', () => {
    it('reads an oversized transcript tail-first, dropping the first partial line', async () => {
      const file = path.join(tmpBase, 'big.jsonl');
      const head = JSON.stringify({
        type: 'user',
        sessionId: 's5',
        timestamp: '2026-07-22T10:00:00.000Z',
        message: { role: 'user', content: 'THIS HEAD PROMPT IS BEYOND THE CAP' },
      });
      const lastPrompt = JSON.stringify({
        type: 'last-prompt',
        sessionId: 's5',
        timestamp: '2026-07-22T10:01:00.000Z',
        lastPrompt: 'Tail-preserved ask.',
      });
      await fsp.writeFile(file, `${head}\n${lastPrompt}\n`, 'utf8');

      // Cap just below the head line length => only the tail survives, and the
      // (now partial) head line is dropped, so `prompt` falls back to
      // last-prompt.
      const intention = await newService({
        tasksRoot: tmpBase,
        maxBytes: lastPrompt.length + 5,
      }).extract(file);
      expect(intention.prompt).toBe('Tail-preserved ask.');
    });

    it('skips lines that are valid JSON but not objects', async () => {
      const file = path.join(tmpBase, 'scalars.jsonl');
      await fsp.writeFile(
        file,
        [
          '42',
          '"a bare string"',
          'null',
          '[1,2,3]',
          JSON.stringify({
            type: 'user',
            sessionId: 's6',
            timestamp: '2026-07-22T10:00:00.000Z',
            message: { role: 'user', content: 'Survivor prompt.' },
          }),
        ].join('\n'),
        'utf8'
      );
      const intention = await newService({ tasksRoot: tmpBase }).extract(file);
      expect(intention.prompt).toBe('Survivor prompt.');
    });

    it('tolerates records with missing/odd message shapes and no text blocks', async () => {
      const file = path.join(tmpBase, 'odd.jsonl');
      await fsp.writeFile(
        file,
        [
          JSON.stringify({ type: 'user', sessionId: 's7', timestamp: '2026-07-22T10:00:00.000Z' }),
          JSON.stringify({
            type: 'user',
            sessionId: 's7',
            timestamp: '2026-07-22T10:00:01.000Z',
            message: { role: 'user', content: 99 },
          }),
          JSON.stringify({
            type: 'assistant',
            sessionId: 's7',
            timestamp: '2026-07-22T10:00:02.000Z',
            message: 'not-an-object',
          }),
          JSON.stringify({
            type: 'assistant',
            sessionId: 's7',
            timestamp: '2026-07-22T10:00:03.000Z',
            message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }] },
          }),
          JSON.stringify({
            type: 'assistant',
            sessionId: 's7',
            timestamp: '2026-07-22T10:00:04.000Z',
            message: { role: 'assistant', content: 'a bare string, not a block array' },
          }),
        ].join('\n'),
        'utf8'
      );
      const intention = await newService({ tasksRoot: tmpBase }).extract(file);
      expect(intention.prompt).toBeUndefined();
      expect(intention.commentary).toEqual([]);
      expect(intention.summary).toBeUndefined();
    });

    it('skips malformed task files and files without a subject, ordering by numeric prefix', async () => {
      const file = path.join(tmpBase, 'session.jsonl');
      await fsp.writeFile(
        file,
        JSON.stringify({
          type: 'user',
          sessionId: 'sess-tasks',
          timestamp: '2026-07-22T10:00:00.000Z',
          message: { role: 'user', content: 'go' },
        }),
        'utf8'
      );
      const tasksDir = path.join(tmpBase, 'sess-tasks');
      await fsp.mkdir(tasksDir, { recursive: true });
      await fsp.writeFile(path.join(tasksDir, '10.json'), '{ not valid', 'utf8');
      await fsp.writeFile(path.join(tasksDir, '2.json'), JSON.stringify([1, 2, 3]), 'utf8');
      await fsp.writeFile(
        path.join(tasksDir, '3.json'),
        JSON.stringify({ id: 'x', status: 'pending' }),
        'utf8'
      );
      await fsp.writeFile(path.join(tasksDir, 'notes.txt'), 'ignored — not a .json file', 'utf8');
      await fsp.writeFile(
        path.join(tasksDir, '1.json'),
        JSON.stringify({ id: 'a', subject: 'First real task', status: 'unrecognized' }),
        'utf8'
      );
      // A .json file with no numeric prefix sorts last (numericPrefix => ∞).
      await fsp.writeFile(
        path.join(tasksDir, 'extra.json'),
        JSON.stringify({ id: 'z', subject: 'Trailing task', status: 'completed' }),
        'utf8'
      );

      const { tasks } = await newService({ tasksRoot: tmpBase }).extract(file);
      // 1.json (unknown status => pending) then extra.json (no numeric prefix,
      // sorts last).
      expect(tasks).toEqual([
        { subject: 'First real task', status: 'pending' },
        { subject: 'Trailing task', status: 'done' },
      ]);
    });
  });
});
