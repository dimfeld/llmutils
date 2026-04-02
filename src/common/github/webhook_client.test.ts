import { afterEach, describe, expect, mock, test } from 'bun:test';

describe('common/github/webhook_client', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('fetchWebhookEvents returns parsed events from the webhook server', async () => {
    const fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(String(input)).toBe(
          'https://webhooks.example.com/internal/events?afterId=25&limit=50&includeAcked=true'
        );
        expect(init?.headers).toEqual({
          Authorization: 'Bearer shared-token',
        });

        return new Response(
          JSON.stringify({
            events: [
              {
                id: 26,
                deliveryId: 'delivery-26',
                eventType: 'pull_request',
                action: 'opened',
                repositoryFullName: 'example/repo',
                payloadJson: '{"ok":true}',
                receivedAt: '2026-03-30T00:00:00.000Z',
              },
            ],
          })
        );
      }
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const { fetchWebhookEvents } = await import('./webhook_client.ts');
    const events = await fetchWebhookEvents('https://webhooks.example.com', 'shared-token', {
      afterId: 25,
      limit: 50,
    });

    expect(events).toEqual([
      {
        id: 26,
        deliveryId: 'delivery-26',
        eventType: 'pull_request',
        action: 'opened',
        repositoryFullName: 'example/repo',
        payloadJson: '{"ok":true}',
        receivedAt: '2026-03-30T00:00:00.000Z',
      },
    ]);
  });

  test('fetchWebhookEvents accepts snake_case webhook payloads', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            events: [
              {
                id: 27,
                delivery_id: 'delivery-27',
                event_type: 'check_run',
                action: 'completed',
                repository_full_name: 'example/repo',
                payload_json: '{"status":"completed"}',
                received_at: '2026-03-30T00:01:00.000Z',
              },
            ],
          })
        )
    ) as typeof fetch;

    const { fetchWebhookEvents } = await import('./webhook_client.ts');
    const events = await fetchWebhookEvents('https://webhooks.example.com', 'shared-token');

    expect(events).toEqual([
      {
        id: 27,
        deliveryId: 'delivery-27',
        eventType: 'check_run',
        action: 'completed',
        repositoryFullName: 'example/repo',
        payloadJson: '{"status":"completed"}',
        receivedAt: '2026-03-30T00:01:00.000Z',
      },
    ]);
  });

  test('fetchWebhookEvents returns an empty array for an empty events payload and omits unset params', async () => {
    const fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(String(input)).toBe(
          'https://webhooks.example.com/internal/events?includeAcked=true'
        );
        expect(init?.headers).toEqual({
          Authorization: 'Bearer shared-token',
        });

        return new Response(JSON.stringify({ events: [] }));
      }
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const { fetchWebhookEvents } = await import('./webhook_client.ts');
    await expect(
      fetchWebhookEvents('https://webhooks.example.com', 'shared-token')
    ).resolves.toEqual([]);
  });

  test('fetchWebhookEvents returns an empty array on connection failure', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED');
    }) as typeof fetch;
    const warnMock = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnMock;

    try {
      const { fetchWebhookEvents } = await import('./webhook_client.ts');
      await expect(
        fetchWebhookEvents('https://webhooks.example.com', 'shared-token')
      ).resolves.toEqual([]);
      expect(warnMock).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('fetchWebhookEvents throws on non-OK HTTP response', async () => {
    globalThis.fetch = mock(
      async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
    ) as typeof fetch;

    const { fetchWebhookEvents } = await import('./webhook_client.ts');
    await expect(fetchWebhookEvents('https://webhooks.example.com', 'bad-token')).rejects.toThrow(
      /401/
    );
  });

  test('fetchWebhookEvents preserves path prefix in base URL', async () => {
    const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
      expect(String(input)).toContain('/webhooks/internal/events');
      return new Response(JSON.stringify({ events: [] }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { fetchWebhookEvents } = await import('./webhook_client.ts');
    await fetchWebhookEvents('https://host.example.com/webhooks', 'token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('webhook config helpers read environment variables', async () => {
    const previousServerUrl = process.env.TIM_WEBHOOK_SERVER_URL;
    const previousToken = process.env.WEBHOOK_INTERNAL_API_TOKEN;

    process.env.TIM_WEBHOOK_SERVER_URL = 'https://webhooks.example.com';
    process.env.WEBHOOK_INTERNAL_API_TOKEN = 'shared-token';

    try {
      const { getWebhookInternalApiToken, getWebhookServerUrl } =
        await import('./webhook_client.ts');
      expect(getWebhookServerUrl()).toBe('https://webhooks.example.com');
      expect(getWebhookInternalApiToken()).toBe('shared-token');
    } finally {
      if (previousServerUrl === undefined) {
        delete process.env.TIM_WEBHOOK_SERVER_URL;
      } else {
        process.env.TIM_WEBHOOK_SERVER_URL = previousServerUrl;
      }

      if (previousToken === undefined) {
        delete process.env.WEBHOOK_INTERNAL_API_TOKEN;
      } else {
        process.env.WEBHOOK_INTERNAL_API_TOKEN = previousToken;
      }
    }
  });
});
