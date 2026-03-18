import { json } from '@sveltejs/kit';

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

      const close = (skipControllerClose = false) => {
        if (closed) {
          return;
        }

        closed = true;
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

      const snapshot: SessionSnapshot = manager.getSessionSnapshot();
      send('session:list', snapshot);
      snapshotSent = true;

      for (const { event, data } of buffered) {
        send(event, data);
      }

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

export async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function badRequest(message: string): Response {
  return json({ error: message }, { status: 400 });
}

export function notFound(message: string): Response {
  return json({ error: message }, { status: 404 });
}

export function success(): Response {
  return json({ success: true });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}
