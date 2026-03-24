import { timingSafeEqual } from 'node:crypto';

import type { HeadlessMessage, HeadlessServerMessage } from '../../logging/headless_protocol.js';
import { parseHeadlessServerMessage } from '../../logging/headless_message_utils.js';

const DEFAULT_AGENT_PATH = '/tim-agent';

interface WebSocketData {
  connectionId: string;
}

export interface EmbeddedServerClient {
  connectionId: string;
}

export interface EmbeddedServerHandle {
  port: number;
  connectedClients: ReadonlyMap<string, EmbeddedServerClient>;
  stop: () => void;
  broadcast: (message: HeadlessMessage) => void;
  broadcastRaw: (payload: string) => void;
  sendTo: (connectionId: string, message: HeadlessMessage) => boolean;
  sendToRaw: (connectionId: string, payload: string) => boolean;
}

export interface StartEmbeddedServerOptions {
  port?: number;
  hostname?: string;
  bearerToken?: string;
  onConnect?: (connectionId: string) => void;
  onMessage?: (connectionId: string, message: HeadlessServerMessage) => void;
  onDisconnect?: (connectionId: string) => void;
}

function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('authorization');
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1];
    }
  }

  const url = new URL(request.url);
  return url.searchParams.get('token');
}

function isAuthorized(request: Request, expectedToken?: string): boolean {
  if (!expectedToken) {
    return true;
  }

  const provided = extractBearerToken(request);
  if (!provided) {
    return false;
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}

export function startEmbeddedServer(
  options: StartEmbeddedServerOptions = {}
): EmbeddedServerHandle {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port ${port}. Must be an integer between 0 and 65535.`);
  }

  const sockets = new Map<string, { send: (payload: string) => unknown }>();
  const connectedClients = new Map<string, EmbeddedServerClient>();

  const server = Bun.serve<WebSocketData>({
    port,
    hostname: options.hostname ?? '127.0.0.1',
    fetch(request, serverRef) {
      const url = new URL(request.url);
      if (url.pathname !== DEFAULT_AGENT_PATH) {
        return new Response('Not Found\n', { status: 404 });
      }

      if (request.method !== 'GET') {
        return new Response('Method Not Allowed\n', {
          status: 405,
          headers: { Allow: 'GET' },
        });
      }

      if (!isAuthorized(request, options.bearerToken)) {
        return new Response('Unauthorized\n', { status: 401 });
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
    },
    websocket: {
      idleTimeout: 0,
      open(ws) {
        const { connectionId } = ws.data;
        sockets.set(connectionId, ws);
        connectedClients.set(connectionId, { connectionId });
        options.onConnect?.(connectionId);
      },
      message(ws, rawMessage) {
        const payload =
          typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage);
        const message = parseHeadlessServerMessage(payload);
        if (!message) {
          return;
        }

        options.onMessage?.(ws.data.connectionId, message);
      },
      close(ws) {
        const { connectionId } = ws.data;
        sockets.delete(connectionId);
        connectedClients.delete(connectionId);
        options.onDisconnect?.(connectionId);
      },
    },
  });

  if (server.port == null) {
    throw new Error('Embedded server did not report a listening port');
  }

  return {
    port: server.port,
    connectedClients,
    stop: () => server.stop(true),
    broadcast: (message) => {
      const payload = JSON.stringify(message);
      for (const ws of sockets.values()) {
        ws.send(payload);
      }
    },
    broadcastRaw: (payload) => {
      for (const ws of sockets.values()) {
        ws.send(payload);
      }
    },
    sendTo: (connectionId, message) => {
      const ws = sockets.get(connectionId);
      if (!ws) {
        return false;
      }

      ws.send(JSON.stringify(message));
      return true;
    },
    sendToRaw: (connectionId, payload) => {
      const ws = sockets.get(connectionId);
      if (!ws) {
        return false;
      }

      ws.send(payload);
      return true;
    },
  };
}
