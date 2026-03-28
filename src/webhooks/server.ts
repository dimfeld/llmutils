import { homedir } from 'node:os';
import { join } from 'node:path';

import { WebhookEventStore } from './db.js';
import { isValidGitHubSignature } from './github.js';
import { hasValidBearerToken, isSecureTransport } from './security.js';

interface ReceiverConfig {
  port: number;
  host: string;
  dbPath: string;
  githubWebhookSecret: string;
  internalApiToken: string;
  requireSecureTransportForInternalRoutes: boolean;
}

interface GitHubWebhookPayload {
  action?: string;
  installation?: { id?: number };
  repository?: { full_name?: string };
}

function getDefaultDbPath(): string {
  return join(homedir(), '.cache', 'tim', 'webhook-receiver.sqlite');
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false;
  }

  return fallback;
}

function loadConfigFromEnv(): ReceiverConfig {
  const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const internalApiToken = process.env.WEBHOOK_INTERNAL_API_TOKEN;

  if (!githubWebhookSecret) {
    throw new Error('GITHUB_WEBHOOK_SECRET is required');
  }
  if (!internalApiToken) {
    throw new Error('WEBHOOK_INTERNAL_API_TOKEN is required');
  }

  const port = Number.parseInt(process.env.WEBHOOK_RECEIVER_PORT ?? '8080', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid WEBHOOK_RECEIVER_PORT: ${process.env.WEBHOOK_RECEIVER_PORT}`);
  }

  return {
    port,
    host: process.env.WEBHOOK_RECEIVER_HOST ?? '0.0.0.0',
    dbPath: process.env.WEBHOOK_DB_PATH ?? getDefaultDbPath(),
    githubWebhookSecret,
    internalApiToken,
    requireSecureTransportForInternalRoutes: parseBooleanEnv(
      process.env.WEBHOOK_REQUIRE_SECURE_INTERNAL_ROUTES,
      true
    ),
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function unauthorizedResponse(): Response {
  return jsonResponse({ error: 'Unauthorized' }, 401);
}

function insecureTransportResponse(): Response {
  return jsonResponse({ error: 'HTTPS is required for internal routes' }, 400);
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function extractWebhookMetadata(payload: GitHubWebhookPayload): {
  action: string | null;
  installationId: number | null;
  repositoryFullName: string | null;
} {
  return {
    action: payload.action ?? null,
    installationId: typeof payload.installation?.id === 'number' ? payload.installation.id : null,
    repositoryFullName: payload.repository?.full_name ?? null,
  };
}

function verifyInternalRequest(request: Request, config: ReceiverConfig): Response | null {
  if (config.requireSecureTransportForInternalRoutes && !isSecureTransport(request)) {
    return insecureTransportResponse();
  }

  if (!hasValidBearerToken(request, config.internalApiToken)) {
    return unauthorizedResponse();
  }

  return null;
}

function buildServer(config: ReceiverConfig): ReturnType<typeof Bun.serve> {
  const store = new WebhookEventStore(config.dbPath);

  return Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (url.pathname === '/healthz' && request.method === 'GET') {
        return jsonResponse({ ok: true });
      }

      if (url.pathname === '/github/webhook' && request.method === 'POST') {
        const deliveryId = request.headers.get('x-github-delivery');
        const eventType = request.headers.get('x-github-event');
        if (!deliveryId || !eventType) {
          return jsonResponse({ error: 'Missing required GitHub headers' }, 400);
        }

        const signature = request.headers.get('x-hub-signature-256');
        const payloadText = await request.text();
        if (!isValidGitHubSignature(payloadText, config.githubWebhookSecret, signature)) {
          return jsonResponse({ error: 'Invalid webhook signature' }, 401);
        }

        let payload: GitHubWebhookPayload;
        try {
          payload = JSON.parse(payloadText) as GitHubWebhookPayload;
        } catch {
          return jsonResponse({ error: 'Invalid JSON payload' }, 400);
        }

        const metadata = extractWebhookMetadata(payload);
        const result = store.insertEvent({
          deliveryId,
          eventType,
          action: metadata.action,
          installationId: metadata.installationId,
          repositoryFullName: metadata.repositoryFullName,
          payloadJson: payloadText,
        });

        if (!result.inserted) {
          return jsonResponse({ status: 'duplicate', deliveryId });
        }

        return jsonResponse({ status: 'accepted', id: result.id, deliveryId }, 202);
      }

      if (url.pathname === '/internal/events' && request.method === 'GET') {
        const rejected = verifyInternalRequest(request, config);
        if (rejected) {
          return rejected;
        }

        const afterId = parsePositiveInt(url.searchParams.get('afterId'), 0);
        const limit = parsePositiveInt(url.searchParams.get('limit'), 100);
        const includeAcked = (url.searchParams.get('includeAcked') ?? '').toLowerCase() === 'true';
        const events = store.listEvents({ afterId, limit, includeAcked });
        return jsonResponse({ events });
      }

      if (url.pathname === '/internal/events/ack' && request.method === 'POST') {
        const rejected = verifyInternalRequest(request, config);
        if (rejected) {
          return rejected;
        }

        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return jsonResponse({ error: 'Invalid JSON payload' }, 400);
        }

        if (
          !payload ||
          typeof payload !== 'object' ||
          !Array.isArray((payload as { deliveryIds?: unknown[] }).deliveryIds)
        ) {
          return jsonResponse({ error: 'Body must include deliveryIds: string[]' }, 400);
        }

        const deliveryIds = (payload as { deliveryIds: unknown[] }).deliveryIds.filter(
          (value): value is string => typeof value === 'string' && value.length > 0
        );
        const ackedCount = store.acknowledgeEvents(deliveryIds);
        return jsonResponse({ ackedCount });
      }

      return new Response('Not Found\n', { status: 404 });
    },
    error(error) {
      console.error('[webhook_receiver] Server error', error);
      return jsonResponse({ error: 'Internal Server Error' }, 500);
    },
  });
}

function main(): void {
  const config = loadConfigFromEnv();
  const server = buildServer(config);

  console.log(
    `[webhook_receiver] listening on http://${server.hostname}:${server.port} using db ${config.dbPath}`
  );
}

main();
