import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MainLogger } from '../ipc/logger';
import type {
  AgentCommentaryEntry,
  AgentIntention,
  AgentTask,
  AgentTaskStatus,
} from '../../shared/types';

// Enrichment (feature-flagged, research note "Mechanism 2"): parse a Claude
// Code session transcript (`~/.claude/projects/<enc-cwd>/<uuid>.jsonl`) and its
// sibling task list (`~/.claude/tasks/<sessionId>/N.json`) into an
// AgentIntention — the derived, privacy-preserving signals (title, prompt,
// task list, the agent's own narrative), never the raw conversation. The
// transcript format is internal and can drift between Claude Code releases, so
// every read here is defensive: bad lines are skipped and counted, unknown
// record types ignored, missing fields tolerated, and any whole-file failure
// degrades to a typed empty result instead of throwing into callers.

// The feature-flag env var. Enrichment is ON unless explicitly turned off
// (default ON in dev, per the packet). Any of off/0/false disables it.
const TRANSCRIPT_ENRICHMENT_ENV = 'LORE_MINIPLAYER_TRANSCRIPT_ENRICHMENT';

// Newest-N cap on commentary entries surfaced (the agent's narrative account).
const COMMENTARY_CAP = 20;

// Upper bound on transcript bytes read into memory. Sessions are typically well
// under this; a file larger than the cap is read TAIL-first (its most recent
// bytes), which keeps the sidecar `ai-title`/`last-prompt` records and the
// latest turn — at the cost of the head, where the very first user prompt
// lives. That loss is why `prompt` falls back to the `last-prompt` record.
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface AgentTranscriptOptions {
  // Explicit on/off. When omitted, resolved from the env feature flag.
  readonly enabled?: boolean;
  // Root of the per-session task directories. Injectable for tests; defaults
  // to `~/.claude/tasks`.
  readonly tasksRoot?: string;
  // Byte cap for reading transcripts (see DEFAULT_MAX_BYTES).
  readonly maxBytes?: number;
  // Clock seam for the running-task elapsed computation. Injectable for tests.
  readonly now?: () => number;
}

// The typed empty result: honored on flag-off and on any whole-file failure.
// tasks/commentary are always present arrays; every other field is omitted.
function emptyIntention(): AgentIntention {
  return { tasks: [], commentary: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Maps a raw Claude Code task status onto the app's three-state vocabulary.
// Verified/known raw values: `pending`, `in_progress`, `completed`. Synonyms
// are folded in defensively; an unrecognized status defaults to `pending` so a
// live task is never silently dropped.
function mapTaskStatus(raw: unknown): AgentTaskStatus {
  switch (raw) {
    case 'completed':
    case 'done':
      return 'done';
    case 'in_progress':
    case 'running':
    case 'active':
      return 'running';
    case 'pending':
    default:
      return 'pending';
  }
}

interface ParsedTranscript {
  // First real user prompt (string content, or the first text block; never a
  // tool_result, never isMeta) — the initiating task.
  firstUserPrompt?: string;
  // Latest `ai-title` record's aiTitle.
  title?: string;
  // Latest `last-prompt` record's lastPrompt — the resilient prompt fallback.
  lastPrompt?: string;
  // All assistant text blocks (thinking excluded), chronological.
  commentary: AgentCommentaryEntry[];
  // Final text block of the latest assistant turn.
  summary?: string;
  // Newest assistant record timestamp (epoch ms) — the running-task clock base.
  newestAssistantMs?: number;
  // Session id observed on any record (falls back to the filename).
  sessionId?: string;
  // Defensive-parse forensics (paths/counts/versions only — never content).
  totalLines: number;
  skippedLines: number;
  versions: Set<string>;
}

// Newest-wins timestamps for the sidecar records (`ai-title`, `last-prompt`),
// tracked across the parse so the latest record wins regardless of file order.
interface SidecarState {
  latestTitleMs: number;
  latestLastPromptMs: number;
}

export class AgentTranscriptService {
  private readonly enabled: boolean;
  private readonly tasksRoot: string;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(
    private readonly log: MainLogger,
    options: AgentTranscriptOptions = {}
  ) {
    this.enabled = options.enabled ?? resolveEnabledFromEnv();
    this.tasksRoot = options.tasksRoot ?? path.join(os.homedir(), '.claude', 'tasks');
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  // Derive an AgentIntention from a transcript path (as delivered by hook
  // payloads). Never throws into the caller: any failure degrades to the typed
  // empty result. Returns the empty result immediately when the flag is off.
  async extract(transcriptPath: string): Promise<AgentIntention> {
    if (!this.enabled) {
      return emptyIntention();
    }

    const content = await this.readBounded(transcriptPath);
    if (content === undefined) {
      return emptyIntention();
    }

    const parsed = this.parseTranscript(content);
    const sessionId = parsed.sessionId ?? path.basename(transcriptPath, '.jsonl');
    const tasks = await this.readTasks(sessionId, parsed.newestAssistantMs);

    this.log.debug('Parsed agent transcript', {
      transcriptPath,
      totalLines: parsed.totalLines,
      skippedLines: parsed.skippedLines,
      commentaryCount: parsed.commentary.length,
      taskCount: tasks.length,
      versions: Array.from(parsed.versions),
    });

    const prompt = parsed.firstUserPrompt ?? parsed.lastPrompt;
    const commentary =
      parsed.commentary.length > COMMENTARY_CAP
        ? parsed.commentary.slice(-COMMENTARY_CAP)
        : parsed.commentary;

    // Assembled with conditional spreads: exactOptionalPropertyTypes forbids
    // assigning `undefined` to an optional field.
    return {
      tasks,
      commentary,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
      ...(sessionId.length > 0 ? { sessionId } : {}),
    };
  }

  // Reads the transcript, tail-first when it exceeds the byte cap. Returns
  // undefined for any whole-file failure (missing, unreadable, empty).
  private async readBounded(transcriptPath: string): Promise<string | undefined> {
    try {
      const stat = await fs.stat(transcriptPath);
      if (stat.size === 0) {
        return undefined;
      }
      if (stat.size <= this.maxBytes) {
        return await fs.readFile(transcriptPath, 'utf8');
      }

      // Oversized: read only the final maxBytes and drop the first (partial)
      // line so no half-record is parsed.
      const handle = await fs.open(transcriptPath, 'r');
      try {
        const buffer = Buffer.alloc(this.maxBytes);
        await handle.read(buffer, 0, this.maxBytes, stat.size - this.maxBytes);
        const tail = buffer.toString('utf8');
        const firstNewline = tail.indexOf('\n');
        this.log.debug('Transcript exceeds byte cap; read tail-first', {
          transcriptPath,
          size: stat.size,
          maxBytes: this.maxBytes,
        });
        return firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
      } finally {
        await handle.close();
      }
    } catch (error) {
      // Missing/unreadable is expected (no session yet, permissions); log the
      // path only, never content.
      this.log.debug('Transcript unreadable; returning empty intention', {
        transcriptPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  // Defensive per-line parse: JSON.parse in try/catch, skipping and counting
  // unparseable lines; unknown record types ignored; missing fields tolerated.
  private parseTranscript(content: string): ParsedTranscript {
    const result: ParsedTranscript = {
      commentary: [],
      totalLines: 0,
      skippedLines: 0,
      versions: new Set<string>(),
    };
    const sidecar: SidecarState = { latestTitleMs: -Infinity, latestLastPromptMs: -Infinity };

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }
      result.totalLines += 1;

      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        result.skippedLines += 1;
        continue;
      }
      if (!isRecord(record)) {
        result.skippedLines += 1;
        continue;
      }

      const version = asString(record['version']);
      if (version !== undefined) {
        result.versions.add(version);
      }
      if (result.sessionId === undefined) {
        const sessionId = asString(record['sessionId']);
        if (sessionId !== undefined) {
          result.sessionId = sessionId;
        }
      }
      this.dispatchRecord(record, result, sidecar);
    }

    return result;
  }

  // Routes one parsed record to its field extractor. Kept separate from the
  // per-line loop so each stays within the complexity budget.
  private dispatchRecord(
    record: Record<string, unknown>,
    result: ParsedTranscript,
    sidecar: SidecarState
  ): void {
    const at = parseTimestamp(record['timestamp']);
    switch (record['type']) {
      case 'user':
        this.consumeUserRecord(record, result);
        break;
      case 'assistant':
        this.consumeAssistantRecord(record, result, at);
        break;
      case 'ai-title': {
        const title = asString(record['aiTitle']);
        if (title !== undefined && at >= sidecar.latestTitleMs) {
          result.title = title;
          sidecar.latestTitleMs = at;
        }
        break;
      }
      case 'last-prompt': {
        const lastPrompt = asString(record['lastPrompt']);
        if (lastPrompt !== undefined && at >= sidecar.latestLastPromptMs) {
          result.lastPrompt = lastPrompt;
          sidecar.latestLastPromptMs = at;
        }
        break;
      }
      default:
        // Unknown/uninteresting record type — ignored by contract.
        break;
    }
  }

  // A user record contributes the first real prompt: string content, or the
  // first text block. Skipped when isMeta, or when the content is only
  // tool_result blocks.
  private consumeUserRecord(record: Record<string, unknown>, result: ParsedTranscript): void {
    if (result.firstUserPrompt !== undefined || record['isMeta'] === true) {
      return;
    }
    const message = record['message'];
    if (!isRecord(message)) {
      return;
    }
    const content = message['content'];
    const text = asString(content) ?? firstTextBlock(content);
    if (text !== undefined) {
      result.firstUserPrompt = text;
    }
  }

  // An assistant record contributes commentary (each text block, thinking
  // excluded) and, for the newest turn, the summary (its final text block).
  private consumeAssistantRecord(
    record: Record<string, unknown>,
    result: ParsedTranscript,
    at: number
  ): void {
    const message = record['message'];
    if (!isRecord(message)) {
      return;
    }
    const texts = textBlocks(message['content']);
    if (texts.length === 0) {
      return;
    }

    if (Number.isFinite(at)) {
      for (const text of texts) {
        result.commentary.push({ at, text });
      }
    }

    // Summary = final text block of the LATEST assistant turn.
    if (result.newestAssistantMs === undefined || at >= result.newestAssistantMs) {
      const finalText = texts[texts.length - 1];
      if (finalText !== undefined) {
        result.summary = finalText;
      }
      if (Number.isFinite(at)) {
        result.newestAssistantMs = at;
      }
    }
  }

  // Reads `<tasksRoot>/<sessionId>/*.json`, ordered by numeric filename, into
  // AgentTask[]. A missing directory yields no tasks (no throw). runningElapsed
  // is derivable only when a running task exists, from the newest assistant
  // record timestamp delta; otherwise omitted.
  private async readTasks(sessionId: string, newestAssistantMs?: number): Promise<AgentTask[]> {
    if (sessionId.length === 0) {
      return [];
    }
    const dir = path.join(this.tasksRoot, sessionId);

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      // Missing/unreadable tasks dir is the common case (no task list yet).
      return [];
    }

    const files = entries
      .filter(name => name.endsWith('.json'))
      .sort((a, b) => numericPrefix(a) - numericPrefix(b));

    const runningElapsedMs =
      newestAssistantMs !== undefined ? Math.max(0, this.now() - newestAssistantMs) : undefined;

    const tasks: AgentTask[] = [];
    for (const name of files) {
      let raw: unknown;
      try {
        raw = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      } catch {
        continue;
      }
      if (!isRecord(raw)) {
        continue;
      }
      const subject = asString(raw['subject']);
      if (subject === undefined) {
        continue;
      }
      const status = mapTaskStatus(raw['status']);
      tasks.push(
        status === 'running' && runningElapsedMs !== undefined
          ? { subject, status, runningElapsedMs }
          : { subject, status }
      );
    }
    return tasks;
  }
}

// off/0/false disables enrichment; anything else (including unset) leaves it ON.
function resolveEnabledFromEnv(): boolean {
  const flag = process.env[TRANSCRIPT_ENRICHMENT_ENV];
  return flag !== 'off' && flag !== '0' && flag !== 'false';
}

// Epoch ms from an ISO timestamp, or NaN when absent/unparseable.
function parseTimestamp(value: unknown): number {
  const iso = asString(value);
  return iso === undefined ? NaN : Date.parse(iso);
}

// The first `text` block's text from a content array, or undefined. tool_result
// and thinking blocks are ignored.
function firstTextBlock(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text') {
      const text = asString(block['text']);
      if (text !== undefined) {
        return text;
      }
    }
  }
  return undefined;
}

// All non-empty `text` block texts from a content array (thinking excluded).
function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text') {
      const text = asString(block['text']);
      if (text !== undefined) {
        texts.push(text);
      }
    }
  }
  return texts;
}

// Leading integer of a task filename (`12.json` -> 12) for ordering; files
// without a numeric prefix sort last.
function numericPrefix(name: string): number {
  const match = /^(\d+)/.exec(name);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}
