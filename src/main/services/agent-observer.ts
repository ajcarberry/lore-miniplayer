import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import type { MainLogger } from '../ipc/logger';
import type { AgentSessionState, AgentSessionStatus } from '../../shared/types';
import type { WorkspaceObserverConfig } from './workspace-service';

// Default loopback port the hook listener binds (research note "Recommended
// shape"). If occupied, start() scans upward; hooks always embed the port
// actually bound (getObserverConfig reads it live), never this constant.
const DEFAULT_OBSERVER_PORT = 41_500;

// How many ports to try past the requested one before giving up.
const PORT_SCAN_ATTEMPTS = 20;

// Hard cap on a hook request body. Real payloads (tool_input included) are
// small; anything larger is rejected rather than buffered — a valid Claude
// Code hook never approaches this.
const MAX_BODY_BYTES = 1_048_576; // 1 MiB

// Slowloris / connection-hoarding posture (defense-in-depth, not relying on
// version-dependent Node defaults). A fire-and-forget hook completes in
// milliseconds; any connection that dawdles past these bounds is torn down so a
// malicious local process cannot tie up sockets by trickling headers/body or
// holding idle connections open.
const HEADERS_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SOCKET_IDLE_TIMEOUT_MS = 15_000;

// The verified hook stdin fields the observer reads (research note "Hook
// injection"). Everything is optional/defensive: the format is external and
// may drift, so unknown shapes degrade rather than throw.
interface HookPayload {
  readonly session_id?: unknown;
  readonly hook_event_name?: unknown;
  readonly notification_type?: unknown;
  readonly transcript_path?: unknown;
  readonly cwd?: unknown;
}

// In-memory per-session record. Carries the schema-visible AgentSessionState
// fields plus transcript_path + latest cwd, which P8 consumes in-process to
// locate and parse the transcript. workspacePath is authoritative from the
// hook's token, never the payload.
export interface AgentSessionRecord {
  sessionId: string;
  workspacePath: string;
  status: AgentSessionStatus;
  lastEventAt: number;
  transcriptPath?: string;
  cwd?: string;
}

// The schema-visible projection of a session record (shared with the
// workspace model, which surfaces the same four fields on its cards).
export function toSessionState(record: AgentSessionRecord): AgentSessionState {
  return {
    sessionId: record.sessionId,
    workspacePath: record.workspacePath,
    status: record.status,
    lastEventAt: record.lastEventAt,
  };
}

export interface AgentObserverOptions {
  readonly port?: number;
  // Injectable clock for deterministic lastEventAt assertions in tests.
  readonly now?: () => number;
}

// Localhost hook listener + per-workspace agent session model. Claude Code
// agents in provisioned workspaces POST fire-and-forget hook events to
// `http://127.0.0.1:<port>/hook/<workspaceToken>`; this service authenticates
// the token, maps the event to an AgentSessionState, keeps it in memory, and
// emits a bare 'push' signal that the workspace model consumes (it re-reads
// session state via listSessions).
//
// Security posture (mission stakes high): bound to 127.0.0.1 only, never
// 0.0.0.0; per-workspace tokens are 32 random bytes (unguessable); payload
// content is only JSON-parsed, never executed/eval'd; request bodies are
// size-capped; rejected requests are logged.
export class AgentObserverService extends EventEmitter {
  private readonly requestedPort: number;
  private readonly now: () => number;

  private server: http.Server | null = null;
  private boundPort = 0;

  // Live sockets, tracked so stop() destroys any straggler and the listener
  // frees cleanly (CLAUDE.md resource-cleanup rule).
  private readonly sockets = new Set<Socket>();

  // Per-workspace token registry (stable per path) and its reverse index, so a
  // hook URL's token resolves to the owning workspace path.
  private readonly tokensByPath = new Map<string, string>();
  private readonly pathByToken = new Map<string, string>();

  // Per-session state keyed by session_id.
  private readonly sessions = new Map<string, AgentSessionRecord>();

  constructor(
    private readonly log: MainLogger,
    options: AgentObserverOptions = {}
  ) {
    super();
    this.requestedPort = options.port ?? DEFAULT_OBSERVER_PORT;
    this.now = options.now ?? ((): number => Date.now());
  }

  // The bound loopback port (0 until start() resolves).
  get port(): number {
    return this.boundPort;
  }

  // The seam WorkspaceService consumes: the live port plus a stable
  // per-workspace token provider, so provisioned hooks point at this listener.
  getObserverConfig(): WorkspaceObserverConfig {
    return {
      port: this.boundPort,
      tokenForWorkspace: (workspacePath: string): string => this.tokenForWorkspace(workspacePath),
    };
  }

  // Snapshot of current sessions (P8 consumes transcriptPath + cwd in-process).
  listSessions(): AgentSessionRecord[] {
    return [...this.sessions.values()].map(record => ({ ...record }));
  }

  // Start the listener, binding 127.0.0.1 only and scanning upward from the
  // requested port if it is occupied.
  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.on('connection', socket => {
      this.sockets.add(socket);
      // Tear down a connection that goes idle (headers/body trickle, or a held
      // keep-alive socket) rather than letting it linger.
      socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => socket.destroy());
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.server = server;
    this.boundPort = await this.listenWithFallback(server, this.requestedPort);
    this.log.info('Agent observer listening', {
      operation: 'agent-observer:start',
      port: this.boundPort,
    });
  }

  // Stop the listener and destroy any lingering sockets. Idempotent.
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = null;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
    this.boundPort = 0;
  }

  // --- internals ------------------------------------------------------------

  private tokenForWorkspace(workspacePath: string): string {
    const existing = this.tokensByPath.get(workspacePath);
    if (existing) {
      return existing;
    }
    const token = randomBytes(32).toString('hex');
    this.tokensByPath.set(workspacePath, token);
    this.pathByToken.set(token, workspacePath);
    return token;
  }

  private listenWithFallback(server: http.Server, startPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      let attempt = 0;
      let current = startPort;

      const onError = (error: Error & { code?: string }): void => {
        if (error.code === 'EADDRINUSE' && attempt < PORT_SCAN_ATTEMPTS) {
          attempt += 1;
          current += 1;
          server.listen(current, '127.0.0.1');
          return;
        }
        server.off('error', onError);
        reject(error);
      };

      server.on('error', onError);
      server.listen(current, '127.0.0.1', () => {
        server.off('error', onError);
        const address = server.address() as AddressInfo | null;
        resolve(address ? address.port : current);
      });
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const token = this.extractToken(req.url);
    const workspacePath = token ? this.pathByToken.get(token) : undefined;

    if (!token || !workspacePath) {
      this.log.error('Agent observer rejected request with unknown/missing token', {
        operation: 'agent-observer:auth',
        url: req.url,
        method: req.method,
      });
      this.respond(res, token ? 403 : 404);
      return;
    }

    let size = 0;
    const chunks: Buffer[] = [];
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        this.log.error('Agent observer rejected oversized hook body', {
          operation: 'agent-observer:body',
          workspacePath,
          size,
        });
        this.respond(res, 413);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) {
        return;
      }
      const body = Buffer.concat(chunks).toString('utf-8');
      let parsed: HookPayload;
      try {
        parsed = JSON.parse(body) as HookPayload;
      } catch (error) {
        this.log.error('Agent observer received malformed hook JSON', {
          error,
          operation: 'agent-observer:parse',
          workspacePath,
        });
        this.respond(res, 400);
        return;
      }
      // Hooks are fire-and-forget: the 200 is written first, and processEvent
      // is fully synchronous (map updates + one emit), so it can never delay
      // the agent's request.
      this.respond(res, 200);
      this.processEvent(workspacePath, parsed);
    });
  }

  private extractToken(url: string | undefined): string | undefined {
    if (!url) {
      return undefined;
    }
    const match = /^\/hook\/([^/?#]+)/.exec(url);
    return match ? match[1] : undefined;
  }

  private processEvent(workspacePath: string, payload: HookPayload): void {
    const sessionId =
      typeof payload.session_id === 'string' && payload.session_id.length > 0
        ? payload.session_id
        : undefined;
    if (!sessionId) {
      this.log.warn('Agent observer hook missing session_id; ignoring', {
        operation: 'agent-observer:event',
        workspacePath,
      });
      return;
    }

    const eventName = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
    const now = this.now();

    const existing = this.sessions.get(sessionId);
    const status = this.mapStatus(eventName, payload, existing?.status);

    const transcriptPath =
      typeof payload.transcript_path === 'string'
        ? payload.transcript_path
        : existing?.transcriptPath;
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : existing?.cwd;

    const record: AgentSessionRecord = {
      sessionId,
      workspacePath,
      status,
      lastEventAt: now,
      ...(transcriptPath !== undefined ? { transcriptPath } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    };
    this.sessions.set(sessionId, record);

    this.emit('push');
  }

  // Event -> AgentSessionStatus (packet contract). Unknown events keep the
  // prior status (lastEventAt still bumps) and log at debug; a brand-new
  // session first seen via an unknown event defaults to 'active'.
  private mapStatus(
    eventName: string,
    payload: HookPayload,
    prior: AgentSessionStatus | undefined
  ): AgentSessionStatus {
    switch (eventName) {
      case 'SessionStart':
        return 'active';
      case 'UserPromptSubmit':
      case 'PostToolUse':
        return 'active';
      case 'Notification':
        return payload.notification_type === 'permission_prompt' ||
          payload.notification_type === 'idle_prompt'
          ? 'waitingOnUser'
          : (prior ?? 'active');
      case 'Stop':
        return 'stopped';
      case 'SessionEnd':
        return 'ended';
      default:
        this.log.debug('Agent observer unknown hook event; bumping lastEventAt only', {
          operation: 'agent-observer:event',
          hookEventName: eventName,
        });
        return prior ?? 'active';
    }
  }

  private respond(res: http.ServerResponse, statusCode: number): void {
    res.writeHead(statusCode);
    res.end();
  }
}
