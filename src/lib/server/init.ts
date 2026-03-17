import type { Database } from 'bun:sqlite';

import { loadGlobalConfigForNotifications } from '$tim/configLoader.js';
import type { TimConfig } from '$tim/configSchema.js';
import { getDatabase } from '$tim/db/database.js';

export interface ServerContext {
  config: TimConfig;
  db: Database;
}

let serverContextPromise: Promise<ServerContext> | null = null;

async function initializeServerContext(): Promise<ServerContext> {
  const config = await loadGlobalConfigForNotifications();
  const db = getDatabase();

  return {
    config,
    db,
  };
}

export async function getServerContext(): Promise<ServerContext> {
  serverContextPromise ??= initializeServerContext().catch((error) => {
    serverContextPromise = null;
    throw error;
  });
  return serverContextPromise;
}
