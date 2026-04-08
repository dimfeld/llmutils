import type { SessionManager, SessionManagerEvents, SessionSnapshot } from './session_manager.js';
import { subscribeToAllSessionEvents } from './session_manager.js';

type SessionEventName = keyof SessionManagerEvents;

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
    start(controller) {
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
        if (snapshotSent) {
          send(eventName, payload);
        } else {
          buffered.push({ event: eventName, data: payload });
        }
      });
      // Handle already-aborted requests immediately
      if (signal?.aborted) {
        close();
        return;
      }

      manager.registerSSESubscriber();
      sseRegistered = true;

      const snapshot: SessionSnapshot = manager.getSessionSnapshot();
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
    cancel() {
      // Stream is already being torn down by the consumer, so skip controller.close()
      cleanup?.(true);
    },
  });

  return new Response(stream, {
    headers: SSE_HEADERS,
  });
}
