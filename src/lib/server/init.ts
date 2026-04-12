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
  // The web UI spans multiple repositories at once ("all projects", cross-project dashboards,
  // session views, etc.), so the shared server context must not eagerly bind itself to any
  // single repository's effective config. Repository-specific config is loaded later by callers
  // that already know which repo/workspace they are operating on.
  const config = await loadGlobalConfigForNotifications();
  const db = getDatabase();

  return {
    config,
    db,
  };
}

export async function getServerContext(): Promise<ServerContext> {
  // This intentionally returns global-only config plus the shared DB handle.
  // Do not treat `config` here as the effective repo config for a particular project.
  serverContextPromise ??= initializeServerContext().catch((error) => {
    serverContextPromise = null;
    throw error;
  });
  return serverContextPromise;
}
