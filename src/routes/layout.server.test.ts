import type { Database } from 'bun:sqlite';
import type { Cookies } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { openDatabase } from '$tim/db/database.js';
import type { TimConfig } from '$tim/configSchema.js';

let currentDb: Database;
let currentConfig: TimConfig;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: currentConfig,
    db: currentDb,
  }),
}));

import { load } from './+layout.server.js';

function createCookies(values: Record<string, string> = {}): Cookies {
  return {
    get: (name: string): string | undefined => values[name],
  } as Cookies;
}

describe('routes/+layout.server', () => {
  const originalTimWsPort = process.env.TIM_WS_PORT;

  beforeEach(() => {
    currentDb = openDatabase(':memory:');
    currentConfig = {
      headless: {
        url: 'ws://localhost:8123/tim-agent',
      },
    };
  });

  afterEach(() => {
    currentDb.close(false);
    if (originalTimWsPort === undefined) {
      delete process.env.TIM_WS_PORT;
    } else {
      process.env.TIM_WS_PORT = originalTimWsPort;
    }
  });

  test('exposes the resolved PTY websocket port in layout data', async () => {
    process.env.TIM_WS_PORT = '9345';
    currentConfig = {
      headless: {
        url: 'ws://localhost:8123/tim-agent',
      },
    };

    const data = await load({ cookies: createCookies() } as never);

    expect(data.ptyWebSocketPort).toBe(9345);
  });
});
