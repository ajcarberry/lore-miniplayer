// Integration tests for the agent observability service: a real localhost
// HTTP hook listener driven by a real HTTP client (node:http). No mocks for
// the transport — only the logger is a spy. Payloads are modeled on the
// research note's verified Claude Code hook fields (session_id,
// hook_event_name, notification_type, transcript_path, cwd, tool_name).
import * as http from 'node:http';
import { AgentObserverService } from '../../../src/main/services/agent-observer';
import { AgentObservabilityPushSchema, AgentSessionStateSchema } from '../../../src/shared/schemas';
import type { AgentObservabilityPush } from '../../../src/shared/types';

const mockLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };

const WORKSPACE_A = '/tmp/repo-wt/feature-a';
const WORKSPACE_B = '/tmp/repo-wt/feature-b';

// Wait for the next 'push' payload the service emits (state updates are
// processed after the HTTP response, so tests await the emit, not the fetch).
function nextPush(service: AgentObserverService): Promise<AgentObservabilityPush> {
  return new Promise(resolve => {
    service.once('push', (payload: AgentObservabilityPush) => resolve(payload));
  });
}

// Minimal loopback HTTP client via node:http — jsdom's fetch does not reach a
// real localhost socket, so the transport is exercised with the core client.
function post(port: number, requestPath: string, body: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      res => {
        res.on('data', () => undefined);
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function postHook(
  service: AgentObserverService,
  token: string,
  body: string
): Promise<{ status: number }> {
  return post(service.port, `/hook/${token}`, body);
}

function payload(fields: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: 'sess-1',
    transcript_path: '/Users/alex/.claude/projects/enc/sess-1.jsonl',
    cwd: WORKSPACE_A,
    ...fields,
  });
}

describe('AgentObserverService', () => {
  let service: AgentObserverService;
  let token: string;

  beforeEach(async () => {
    service = new AgentObserverService(mockLog as never, { port: 0 });
    await service.start();
    token = service.getObserverConfig().tokenForWorkspace(WORKSPACE_A);
  });

  afterEach(async () => {
    await service.stop();
  });

  describe('binding and config', () => {
    it('binds a loopback port and exposes it through the observer config', () => {
      // Given a started service; When reading the config; Then the port is a
      // real bound TCP port matching the listener.
      expect(service.port).toBeGreaterThan(0);
      expect(service.getObserverConfig().port).toBe(service.port);
    });

    it('returns a stable, unguessable token per workspace', () => {
      const again = service.getObserverConfig().tokenForWorkspace(WORKSPACE_A);
      const other = service.getObserverConfig().tokenForWorkspace(WORKSPACE_B);
      expect(again).toBe(token);
      expect(other).not.toBe(token);
      // crypto.randomBytes(32) hex -> 64 chars, effectively unguessable.
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('bounds slow/held connections with explicit header and request timeouts', () => {
      // Slowloris posture: the listener must not rely on version-dependent Node
      // defaults. Both timeouts are finite and positive so a trickling or held
      // connection is torn down instead of tying up a socket indefinitely.
      const server = (service as unknown as { server: http.Server | null }).server;
      expect(server).not.toBeNull();
      expect(server?.headersTimeout).toBeGreaterThan(0);
      expect(server?.requestTimeout).toBeGreaterThan(0);
    });
  });

  describe('token authentication', () => {
    it('accepts a request with a valid workspace token (200)', async () => {
      const { status } = await postHook(
        service,
        token,
        payload({ hook_event_name: 'SessionStart' })
      );
      expect(status).toBe(200);
    });

    it('rejects an unknown token with 403 and logs it', async () => {
      const { status } = await postHook(
        service,
        'deadbeef',
        payload({ hook_event_name: 'SessionStart' })
      );
      expect(status).toBe(403);
      expect(mockLog.error).toHaveBeenCalled();
    });

    it('rejects a missing token (bare /hook/) without creating a session', async () => {
      const { status } = await post(
        service.port,
        '/hook/',
        payload({ hook_event_name: 'SessionStart' })
      );
      expect(status).toBeGreaterThanOrEqual(400);
      expect(service.listSessions()).toHaveLength(0);
    });
  });

  describe('event -> state mapping', () => {
    const cases: Array<{ event: Record<string, unknown>; status: string }> = [
      { event: { hook_event_name: 'SessionStart' }, status: 'active' },
      {
        event: { hook_event_name: 'Notification', notification_type: 'permission_prompt' },
        status: 'waitingOnUser',
      },
      {
        event: { hook_event_name: 'Notification', notification_type: 'idle_prompt' },
        status: 'waitingOnUser',
      },
      { event: { hook_event_name: 'UserPromptSubmit' }, status: 'active' },
      { event: { hook_event_name: 'PostToolUse', tool_name: 'Edit' }, status: 'active' },
      { event: { hook_event_name: 'Stop' }, status: 'stopped' },
      { event: { hook_event_name: 'SessionEnd' }, status: 'ended' },
    ];

    it.each(cases)('maps $event.hook_event_name -> $status', async ({ event, status }) => {
      const pushed = nextPush(service);
      const { status: httpStatus } = await postHook(service, token, payload(event));
      expect(httpStatus).toBe(200);
      const push = await pushed;
      expect(push.kind).toBe('sessionState');
      if (push.kind === 'sessionState') {
        expect(push.state.status).toBe(status);
        expect(push.state.workspacePath).toBe(WORKSPACE_A);
        expect(push.state.sessionId).toBe('sess-1');
        // Outbound payload is schema-valid.
        expect(() => AgentObservabilityPushSchema.parse(push)).not.toThrow();
        expect(() => AgentSessionStateSchema.parse(push.state)).not.toThrow();
      }
    });

    it('derives workspacePath from the token, not the payload cwd', async () => {
      const pushed = nextPush(service);
      // cwd deliberately points elsewhere; the token is authoritative.
      await postHook(
        service,
        token,
        payload({ hook_event_name: 'SessionStart', cwd: '/somewhere/else' })
      );
      const push = await pushed;
      if (push.kind === 'sessionState') {
        expect(push.state.workspacePath).toBe(WORKSPACE_A);
      }
    });
  });

  describe('malformed and unknown payloads', () => {
    it('returns 400 for malformed JSON, logs, and never throws', async () => {
      const { status } = await postHook(service, token, '{not valid json');
      expect(status).toBe(400);
      expect(mockLog.error).toHaveBeenCalled();
      expect(service.listSessions()).toHaveLength(0);
    });

    it('bumps lastEventAt only for an unknown event on an existing session', async () => {
      let clock = 1000;
      const svc = new AgentObserverService(mockLog as never, { port: 0, now: () => clock });
      await svc.start();
      const tok = svc.getObserverConfig().tokenForWorkspace(WORKSPACE_A);
      try {
        await new Promise<void>(resolve => {
          svc.once('push', () => resolve());
          void postHook(svc, tok, payload({ hook_event_name: 'SessionStart' }));
        });
        expect(svc.listSessions()[0]?.status).toBe('active');
        expect(svc.listSessions()[0]?.lastEventAt).toBe(1000);

        clock = 2000;
        await new Promise<void>(resolve => {
          svc.once('push', () => resolve());
          void postHook(svc, tok, payload({ hook_event_name: 'PreCompact' }));
        });
        // Status unchanged; timestamp advanced.
        expect(svc.listSessions()[0]?.status).toBe('active');
        expect(svc.listSessions()[0]?.lastEventAt).toBe(2000);
      } finally {
        await svc.stop();
      }
    });
  });

  describe('session state retention', () => {
    it('retains transcript_path and latest cwd per session', async () => {
      await new Promise<void>(resolve => {
        service.once('push', () => resolve());
        void postHook(
          service,
          token,
          payload({ hook_event_name: 'SessionStart', cwd: WORKSPACE_A })
        );
      });
      const [session] = service.listSessions();
      expect(session?.transcriptPath).toBe('/Users/alex/.claude/projects/enc/sess-1.jsonl');
      expect(session?.cwd).toBe(WORKSPACE_A);
      expect(session?.sessionId).toBe('sess-1');
    });

    it('bumps lastEventAt across successive events', async () => {
      let clock = 100;
      const svc = new AgentObserverService(mockLog as never, { port: 0, now: () => clock });
      await svc.start();
      const tok = svc.getObserverConfig().tokenForWorkspace(WORKSPACE_A);
      try {
        await new Promise<void>(resolve => {
          svc.once('push', () => resolve());
          void postHook(svc, tok, payload({ hook_event_name: 'SessionStart' }));
        });
        clock = 250;
        await new Promise<void>(resolve => {
          svc.once('push', () => resolve());
          void postHook(svc, tok, payload({ hook_event_name: 'PostToolUse' }));
        });
        expect(svc.listSessions()[0]?.lastEventAt).toBe(250);
      } finally {
        await svc.stop();
      }
    });
  });

  describe('multi-workspace isolation', () => {
    it('scopes sessions to the token that received the hook', async () => {
      const tokenB = service.getObserverConfig().tokenForWorkspace(WORKSPACE_B);

      await new Promise<void>(resolve => {
        service.once('push', () => resolve());
        void postHook(
          service,
          token,
          JSON.stringify({
            session_id: 'sess-a',
            hook_event_name: 'SessionStart',
            cwd: WORKSPACE_A,
          })
        );
      });
      await new Promise<void>(resolve => {
        service.once('push', () => resolve());
        void postHook(
          service,
          tokenB,
          JSON.stringify({
            session_id: 'sess-b',
            hook_event_name: 'Notification',
            notification_type: 'permission_prompt',
            cwd: WORKSPACE_B,
          })
        );
      });

      const byId = new Map(service.listSessions().map(s => [s.sessionId, s]));
      expect(byId.get('sess-a')?.workspacePath).toBe(WORKSPACE_A);
      expect(byId.get('sess-a')?.status).toBe('active');
      expect(byId.get('sess-b')?.workspacePath).toBe(WORKSPACE_B);
      expect(byId.get('sess-b')?.status).toBe('waitingOnUser');
    });
  });

  describe('lifecycle', () => {
    it('stops the listener and refuses further connections', async () => {
      const port = service.port;
      const tok = token;
      await service.stop();
      await expect(
        post(port, `/hook/${tok}`, payload({ hook_event_name: 'SessionStart' }))
      ).rejects.toThrow();
      // Idempotent stop in afterEach must not throw.
    });

    it('falls back to another port when the requested one is occupied', async () => {
      const blocker = http.createServer();
      await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
      const occupied = (blocker.address() as { port: number }).port;
      const svc = new AgentObserverService(mockLog as never, { port: occupied });
      try {
        await svc.start();
        expect(svc.port).toBeGreaterThan(0);
        expect(svc.port).not.toBe(occupied);
      } finally {
        await svc.stop();
        await new Promise<void>(resolve => blocker.close(() => resolve()));
      }
    });
  });
});
