import type { SessionManager, SessionSnapshot } from './session_manager.js';
import { subscribeToAllSessionEvents } from './session_manager.js';

const SSE_HEADERS = {
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'Content-Type': 'text/event-stream',
} as const;

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
          send(outgoingEvent, outgoingPayload);
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
