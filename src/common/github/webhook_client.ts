export interface WebhookEvent {
  id: number;
  deliveryId: string;
  eventType: string;
  action: string | null;
  repositoryFullName: string | null;
  payloadJson: string;
  receivedAt: string;
}

export interface FetchWebhookEventsOptions {
  afterId?: number;
  limit?: number;
}

interface WebhookEventsResponse {
  events?: unknown[];
}

interface RawWebhookEvent {
  id?: unknown;
  deliveryId?: unknown;
  delivery_id?: unknown;
  eventType?: unknown;
  event_type?: unknown;
  action?: unknown;
  repositoryFullName?: unknown;
  repository_full_name?: unknown;
  payloadJson?: unknown;
  payload_json?: unknown;
  receivedAt?: unknown;
  received_at?: unknown;
}

function toWebhookEvent(rawEvent: unknown): WebhookEvent | null {
  if (!rawEvent || typeof rawEvent !== 'object') {
    return null;
  }

  const event = rawEvent as RawWebhookEvent;
  const id = typeof event.id === 'number' ? event.id : Number(event.id);
  const deliveryId =
    typeof event.deliveryId === 'string'
      ? event.deliveryId
      : typeof event.delivery_id === 'string'
        ? event.delivery_id
        : null;
  const eventType =
    typeof event.eventType === 'string'
      ? event.eventType
      : typeof event.event_type === 'string'
        ? event.event_type
        : null;
  const payloadJson =
    typeof event.payloadJson === 'string'
      ? event.payloadJson
      : typeof event.payload_json === 'string'
        ? event.payload_json
        : null;
  const receivedAt =
    typeof event.receivedAt === 'string'
      ? event.receivedAt
      : typeof event.received_at === 'string'
        ? event.received_at
        : null;

  if (!Number.isFinite(id) || !deliveryId || !eventType || !payloadJson || !receivedAt) {
    return null;
  }

  return {
    id,
    deliveryId,
    eventType,
    action: typeof event.action === 'string' ? event.action : null,
    repositoryFullName:
      typeof event.repositoryFullName === 'string'
        ? event.repositoryFullName
        : typeof event.repository_full_name === 'string'
          ? event.repository_full_name
          : null,
    payloadJson,
    receivedAt,
  };
}

export function getWebhookServerUrl(): string | null {
  return process.env.TIM_WEBHOOK_SERVER_URL ?? null;
}

export function getWebhookInternalApiToken(): string | null {
  return process.env.WEBHOOK_INTERNAL_API_TOKEN ?? null;
}

function isConnectionError(err: unknown): boolean {
  if (err instanceof TypeError) {
    // fetch throws TypeError for network failures (e.g. "fetch failed", "ECONNREFUSED")
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed/i.test(message);
}

export async function fetchWebhookEvents(
  serverUrl: string,
  token: string,
  options: FetchWebhookEventsOptions = {}
): Promise<WebhookEvent[]> {
  // Resolve relative to base URL, preserving any path prefix
  const base = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
  const url = new URL('internal/events', base);

  if (options.afterId !== undefined) {
    url.searchParams.set('afterId', String(options.afterId));
  }
  if (options.limit !== undefined) {
    url.searchParams.set('limit', String(options.limit));
  }
  url.searchParams.set('includeAcked', 'true');

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Webhook server returned ${response.status} ${response.statusText} from ${url.toString()}`
      );
    }

    const payload = (await response.json()) as WebhookEventsResponse;
    if (!Array.isArray(payload.events)) {
      throw new Error(`Webhook server returned unexpected response shape from ${url.toString()}`);
    }

    return payload.events
      .map((event) => toWebhookEvent(event))
      .filter((event): event is WebhookEvent => event !== null);
  } catch (err) {
    if (isConnectionError(err)) {
      console.warn(`Webhook server unreachable at ${url.toString()}: ${err as Error}`);
      return [];
    }
    throw err;
  }
}
