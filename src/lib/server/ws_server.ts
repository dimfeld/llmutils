import process from 'node:process';

import type { TimConfig } from '$tim/configSchema.js';
import { resolveHeadlessUrl } from '$tim/headless.js';

import type { HeadlessMessage } from '../../logging/headless_protocol.js';
import type { MessagePayload, SessionManager } from './session_manager.js';

const DEFAULT_WS_PORT = 8123;
const DEFAULT_AGENT_PATH = '/tim-agent';
const NOTIFICATION_PATH = '/messages';

interface WebSocketData {
  connectionId: string;
}

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

const VALID_HEADLESS_TYPES = new Set(['session_info', 'replay_start', 'replay_end', 'output']);

function parseHeadlessMessage(payload: string): HeadlessMessage | null {
  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
      return null;
    }
    if (!VALID_HEADLESS_TYPES.has(parsed.type)) {
      return null;
    }
    // Validate required fields for output messages
    if (parsed.type === 'output' && (typeof parsed.seq !== 'number' || !parsed.message)) {
      return null;
    }
    return parsed as HeadlessMessage;
  } catch {
    return null;
  }
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
            data: { connectionId },
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

      return new Response('Not Found\n', { status: 404 });
    },
    websocket: {
      open(ws) {
        const { connectionId } = ws.data;
        sessionManager.handleWebSocketConnect(connectionId, (message) => {
          ws.send(JSON.stringify(message));
        });
      },
      message(ws, rawMessage) {
        const payload =
          typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage);
        const message = parseHeadlessMessage(payload);
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
        sessionManager.handleWebSocketDisconnect(ws.data.connectionId);
      },
    },
  });

  return {
    port: server.port ?? port,
    stop: () => server.stop(true),
  };
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
