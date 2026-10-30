import type { SessionManager, SessionSnapshot } from './session_manager.js';
import { subscribeToAllSessionEvents } from './session_manager.js';

const SSE_HEADERS = {
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'Content-Type': 'text/event-stream',
} as const;

/** Minimum time between `session:activity` events for one session on one stream. */
export const SESSION_ACTIVITY_THROTTLE_MS = 1000;

function getEventConnectionId(payload: object): string | null {
  if ('connectionId' in payload && typeof payload.connectionId === 'string') {
    return payload.connectionId;
  }
  if (
    'session' in payload &&
    payload.session != null &&
    typeof payload.session === 'object' &&
    'connectionId' in payload.session &&
    typeof payload.session.connectionId === 'string'
  ) {
    return payload.session.connectionId;
  }
  return null;
}

export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createSessionEventsResponse(
  manager: SessionManager,
  signal?: AbortSignal
): Response {
  const encoder = new TextEncoder();
  let cleanup: ((skipControllerClose?: boolean) => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
      let closed = false;
      let sseRegistered = false;

      const close = (skipControllerClose = false) => {
        if (closed) {
          return;
        }

        closed = true;
        if (sseRegistered) {
          manager.unregisterSSESubscriber();
        }
        unsubscribe();
        clearActivityThrottles();
        signal?.removeEventListener('abort', onAbort);

        if (!skipControllerClose) {
          try {
            controller.close();
          } catch {
            // Stream may already be closing (e.g. from cancel() callback)
          }
        }
      };
      cleanup = close;

      const onAbort = () => close();

      // Busy sessions can produce many messages per second. Each activity event makes the
      // browser rebuild all its session-wide state, so send at most one per session per
      // throttle window and always send the latest timestamp at the end of the window.
      const activityThrottles = new Map<
        string,
        { timer: ReturnType<typeof setTimeout> | null; pendingTimestamp: string | null }
      >();
      const sendThrottledActivity = (connectionId: string, timestamp: string): void => {
        const throttle = activityThrottles.get(connectionId);
        if (throttle) {
          throttle.pendingTimestamp = timestamp;
          return;
        }

        send('session:activity', { connectionId, timestamp });
        const entry: {
          timer: ReturnType<typeof setTimeout> | null;
          pendingTimestamp: string | null;
        } = { timer: null, pendingTimestamp: null };
        const flush = (): void => {
          if (entry.pendingTimestamp == null) {
            activityThrottles.delete(connectionId);
            return;
          }
          send('session:activity', { connectionId, timestamp: entry.pendingTimestamp });
          entry.pendingTimestamp = null;
          entry.timer = setTimeout(flush, SESSION_ACTIVITY_THROTTLE_MS);
        };
        entry.timer = setTimeout(flush, SESSION_ACTIVITY_THROTTLE_MS);
        activityThrottles.set(connectionId, entry);
      };
      // Send a pending activity event now, so it never arrives after a later event for the
      // same session.
      const flushPendingActivity = (connectionId: string): void => {
        const entry = activityThrottles.get(connectionId);
        if (entry?.pendingTimestamp == null) return;
        send('session:activity', { connectionId, timestamp: entry.pendingTimestamp });
        entry.pendingTimestamp = null;
      };
      const clearActivityThrottles = (): void => {
        for (const entry of activityThrottles.values()) {
          if (entry.timer) clearTimeout(entry.timer);
        }
        activityThrottles.clear();
      };

      const send = (event: string, data: unknown) => {
        if (closed) {
          return;
        }

        try {
          controller.enqueue(encoder.encode(formatSseEvent(event, data)));
        } catch {
          close();
        }
      };

      // Subscribe before taking snapshot to avoid losing events between
      // snapshot and subscription. Buffer events until snapshot is sent.
      const buffered: Array<{ event: string; data: unknown }> = [];
      let snapshotSent = false;

      const unsubscribe = subscribeToAllSessionEvents(manager, (eventName, payload) => {
        const outgoingEvent =
          'message' in payload && !payload.message.triggersNotification
            ? 'session:activity'
            : eventName;
        const outgoingPayload: unknown =
          outgoingEvent === 'session:activity' && 'message' in payload
            ? { connectionId: payload.connectionId, timestamp: payload.message.timestamp }
            : eventName === 'session:update' &&
                'session' in payload &&
                payload.session.messages.length > 0
              ? {
                  session: {
                    ...payload.session,
                    lastMessageAt: payload.session.messages.at(-1)?.timestamp ?? null,
                    messages: [],
                  },
                }
              : payload;
        if (snapshotSent) {
          if (outgoingEvent === 'session:activity' && 'message' in payload) {
            sendThrottledActivity(payload.connectionId, payload.message.timestamp);
          } else {
            const connectionId = getEventConnectionId(payload);
            if (connectionId) flushPendingActivity(connectionId);
            send(outgoingEvent, outgoingPayload);
          }
        } else {
          buffered.push({ event: outgoingEvent, data: outgoingPayload });
        }
      });
      // Handle already-aborted requests immediately
      if (signal?.aborted) {
        close();
        return;
      }

      manager.registerSSESubscriber();
      sseRegistered = true;

      const snapshot: SessionSnapshot = manager.getSessionMetadataSnapshot();
      send('session:list', snapshot);

      const rateLimitState = manager.getRateLimitState();
      send('rate-limit:updated', { state: rateLimitState });

      snapshotSent = true;

      for (const { event, data } of buffered) {
        send(event, data);
      }

      send('session:sync-complete', {});

      signal?.addEventListener('abort', onAbort, { once: true });
    },
    cancel(): void {
      // Stream is already being torn down by the consumer, so skip controller.close()
      cleanup?.(true);
    },
  });

  return new Response(stream, {
    headers: SSE_HEADERS,
  });
}

export function createSessionTranscriptResponse(
  manager: SessionManager,
  connectionId: string,
  signal?: AbortSignal
): Response {
  if (!manager.hasSession(connectionId)) {
    return new Response('Session not found', { status: 404 });
  }

  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
      let closed = false;
      const buffered: Array<{ event: string; data: unknown }> = [];
      let snapshotSent = false;
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(formatSseEvent(event, data)));
        } catch {
          close();
        }
      };
      const deliver = (event: string, data: unknown): void => {
        if (snapshotSent) send(event, data);
        else buffered.push({ event, data });
      };
      const unsubscribeMessage = manager.subscribe('session:message', (payload) => {
        if (payload.connectionId === connectionId) deliver('session:message', payload);
      });
      const unsubscribeUpdate = manager.subscribe('session:update', (payload) => {
        if (payload.session.connectionId === connectionId && payload.session.messages.length > 0) {
          deliver('session:transcript', payload);
        }
      });
      const close = (): void => {
        if (closed) return;
        closed = true;
        unsubscribeMessage();
        unsubscribeUpdate();
        signal?.removeEventListener('abort', close);
        try {
          controller.close();
        } catch {
          /* Stream was canceled. */
        }
      };
      cleanup = close;
      if (signal?.aborted) {
        close();
        return;
      }
      const session = manager.getSessionTranscript(connectionId);
      if (session) send('session:transcript', { session });
      snapshotSent = true;
      for (const item of buffered) deliver(item.event, item.data);
      signal?.addEventListener('abort', close, { once: true });
    },
    cancel(): void {
      cleanup?.();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
