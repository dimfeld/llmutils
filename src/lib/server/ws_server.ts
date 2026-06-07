import process from 'node:process';
import { inspect } from 'node:util';

import type { TimConfig } from '$tim/configSchema.js';
import { resolveHeadlessUrl } from '$tim/headless.js';

import { parseHeadlessMessage } from '../../logging/headless_message_utils.js';
import type { MessagePayload, SessionManager } from './session_manager.js';

const DEFAULT_WS_PORT = 8123;
const DEFAULT_AGENT_PATH = '/tim-agent';
const NOTIFICATION_PATH = '/messages';
const PTY_PATH = '/pty';
const MAX_LOG_STRING_LENGTH = 200;

interface AgentWebSocketData {
  kind: 'agent';
  connectionId: string;
}

interface PtyWebSocketData {
  kind: 'pty';
  connectionId: string;
  unsubscribe?: () => void;
}

type WebSocketData = AgentWebSocketData | PtyWebSocketData;

export interface WebSocketServerHandle {
  port: number;
  stop: () => void;
}

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

function parsePortString(value?: string | null): number | null {
  if (!value?.trim()) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return isValidPort(parsed) ? parsed : null;
}

export interface HeadlessServerConfig {
  port: number;
  agentPath: string;
}

export function resolveHeadlessServerConfig(
  config: Pick<TimConfig, 'headless'>
): HeadlessServerConfig {
  const envPort = parsePortString(process.env.TIM_WS_PORT);
  const resolvedUrl = resolveHeadlessUrl(config);

  let port = DEFAULT_WS_PORT;
  let agentPath = DEFAULT_AGENT_PATH;

  try {
    const url = new URL(resolvedUrl);
    const parsedPort = parsePortString(url.port);
    if (parsedPort != null) {
      port = parsedPort;
    }
    // Always use the pathname from the resolved URL. The default URL
    // (ws://localhost:8123/tim-agent) provides /tim-agent, and custom URLs
    // are used as-is so the server matches exactly where agents connect.
    agentPath = url.pathname;
  } catch {
    // Ignore invalid URLs and use defaults.
  }

  // TIM_WS_PORT env var overrides the port from the URL.
  if (envPort != null) {
    port = envPort;
  }

  return { port, agentPath };
}

/** @deprecated Use resolveHeadlessServerConfig instead */
export function resolveHeadlessServerPort(config: Pick<TimConfig, 'headless'>): number {
  return resolveHeadlessServerConfig(config).port;
}

function truncateLogString(value: string): string {
  if (value.length <= MAX_LOG_STRING_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_LOG_STRING_LENGTH)}...(${value.length - MAX_LOG_STRING_LENGTH} more chars)`;
}

function sanitizeMessageForLog(value: unknown): unknown {
  if (typeof value === 'string') {
    return truncateLogString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMessageForLog(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, sanitizeMessageForLog(nestedValue)])
    );
  }

  return value;
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function isLoopbackHostname(value: string): boolean {
  const hostname = normalizeHostname(value);
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isAllowedPtyOrigin(request: Request, requestUrl: URL): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) {
    return true;
  }

  try {
    const originUrl = new URL(origin);
    const originHost = normalizeHostname(originUrl.hostname);
    const requestHost = normalizeHostname(requestUrl.hostname);

    // The web app runs on a different localhost port than this Bun.serve websocket.
    // Accept local browser origins and same-host deployments, but reject foreign sites.
    return isLoopbackHostname(originHost) || originHost === requestHost;
  } catch {
    return false;
  }
}

interface PtyResizeFrame {
  type: 'resize';
  cols: number;
  rows: number;
}

function isPtyResizeFrame(value: unknown): value is PtyResizeFrame {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const frame = value as Record<string, unknown>;
  const cols = frame.cols;
  const rows = frame.rows;
  return (
    frame.type === 'resize' &&
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    typeof cols === 'number' &&
    typeof rows === 'number' &&
    cols > 0 &&
    rows > 0
  );
}

function decodeWebSocketMessage(rawMessage: string | BufferSource): string {
  return typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage);
}

export function startWebSocketServer(
  sessionManager: SessionManager,
  config: Pick<TimConfig, 'headless'>
): WebSocketServerHandle {
  const { port, agentPath } = resolveHeadlessServerConfig(config);

  const server = Bun.serve<WebSocketData>({
    port,
    fetch(request, serverRef) {
      const url = new URL(request.url);

      if (url.pathname === agentPath) {
        if (request.method !== 'GET') {
          return new Response('Method Not Allowed\n', {
            status: 405,
            headers: { Allow: 'GET' },
          });
        }

        const connectionId = crypto.randomUUID();
        if (
          serverRef.upgrade(request, {
            data: { kind: 'agent', connectionId },
          })
        ) {
          return;
        }

        return new Response('WebSocket upgrade failed\n', { status: 400 });
      }

      if (url.pathname === NOTIFICATION_PATH) {
        if (request.method !== 'POST') {
          return new Response('Method Not Allowed\n', {
            status: 405,
            headers: { Allow: 'POST' },
          });
        }

        return handleNotificationRequest(request, sessionManager);
      }

      if (url.pathname === PTY_PATH) {
        if (request.method !== 'GET') {
          return new Response('Method Not Allowed\n', {
            status: 405,
            headers: { Allow: 'GET' },
          });
        }

        const connectionId = url.searchParams.get('connectionId')?.trim();
        if (!connectionId) {
          return new Response('Missing connectionId\n', { status: 400 });
        }

        if (!isAllowedPtyOrigin(request, url)) {
          return new Response('Forbidden\n', { status: 403 });
        }

        if (
          serverRef.upgrade(request, {
            data: { kind: 'pty', connectionId },
          })
        ) {
          return;
        }

        return new Response('WebSocket upgrade failed\n', { status: 400 });
      }

      return new Response('Not Found\n', { status: 404 });
    },
    websocket: {
      open(ws) {
        const { connectionId, kind } = ws.data;
        if (kind === 'pty') {
          // Forward each base64 pty_output frame to this browser viewer. We do
          // not inspect ws.send's return value: interactive terminal output is
          // assumed to stay bounded, so we rely on Bun's internal send buffer
          // rather than implementing explicit backpressure/corking here. If a
          // PTY ever produces sustained high-volume output for a slow client,
          // revisit with a drop/cork policy.
          ws.data.unsubscribe = sessionManager.registerPtySubscriber(connectionId, (data) => {
            ws.send(data);
          });
          return;
        }

        sessionManager.handleWebSocketConnect(connectionId, (message) => {
          ws.send(JSON.stringify(message));
        });
      },
      message(ws, rawMessage) {
        const payload = decodeWebSocketMessage(rawMessage);
        if (ws.data.kind === 'pty') {
          handlePtyBrowserMessage(sessionManager, ws.data.connectionId, payload);
          return;
        }

        const message = parseHeadlessMessage(payload);
        console.log(
          '[ws_server] Received WebSocket message',
          inspect(
            {
              connectionId: ws.data.connectionId,
              message: sanitizeMessageForLog(message ?? { malformedPayload: payload }),
            },
            { depth: 5 }
          )
        );
        if (!message) {
          console.warn('[ws_server] Ignoring malformed WebSocket message');
          return;
        }
        try {
          sessionManager.handleWebSocketMessage(ws.data.connectionId, message);
        } catch (error) {
          console.warn('[ws_server] Error handling WebSocket message', error);
        }
      },
      close(ws) {
        if (ws.data.kind === 'pty') {
          ws.data.unsubscribe?.();
          ws.data.unsubscribe = undefined;
          return;
        }

        sessionManager.handleWebSocketDisconnect(ws.data.connectionId);
      },
    },
  });

  return {
    port: server.port ?? port,
    stop: () => server.stop(true),
  };
}

function handlePtyBrowserMessage(
  sessionManager: SessionManager,
  connectionId: string,
  payload: string
): void {
  const trimmedPayload = payload.trim();

  // Browser PTY text frames are either resize controls
  // ({ type: "resize", cols, rows }) or opaque base64 keystroke payloads.
  if (trimmedPayload.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedPayload);
    } catch {
      console.warn('[ws_server] Ignoring malformed PTY control frame');
      return;
    }

    if (!isPtyResizeFrame(parsed)) {
      console.warn('[ws_server] Ignoring invalid PTY resize frame');
      return;
    }

    sessionManager.sendPtyResize(connectionId, parsed.cols, parsed.rows);
    return;
  }

  sessionManager.sendPtyInput(connectionId, payload);
}

function isValidNotificationPayload(payload: unknown): payload is MessagePayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as MessagePayload).message === 'string' &&
    typeof (payload as MessagePayload).workspacePath === 'string'
  );
}

async function handleNotificationRequest(
  request: Request,
  sessionManager: SessionManager
): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return new Response('Invalid JSON\n', { status: 400 });
  }

  if (!isValidNotificationPayload(payload)) {
    return new Response('Missing required fields: message, workspacePath\n', { status: 400 });
  }

  sessionManager.handleHttpNotification(payload);
  return new Response(null, { status: 202 });
}
