import * as os from 'node:os';
import { getServerContext } from '$lib/server/init.js';
import { getProjectsWithMetadata } from '$lib/server/db_queries.js';
import { resolveHeadlessServerConfig } from '$lib/server/ws_server.js';
import { getLastProjectId } from '$lib/stores/project.svelte.js';
import { getSidebarCollapsed } from '$lib/stores/ui_state.svelte.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ cookies }) => {
  const { db, config } = await getServerContext();
  const projects = getProjectsWithMetadata(db);
  const lastProjectId = getLastProjectId(cookies);
  const sidebarCollapsed = getSidebarCollapsed(cookies);
  const currentUsername = process.env.USER ?? os.userInfo().username;

  // The browser PTY terminal (plan 382) connects to the standalone Bun.serve
  // headless websocket server, which runs on a different port than the SvelteKit
  // app. Expose the resolved port so the client can build
  // `ws://<window.location.hostname>:<port>/pty?connectionId=...`. The host is
  // derived client-side from window.location, since the server's bind host may be
  // a wildcard/loopback address that is not browser-reachable. The `/pty` path is
  // fixed, so only the port is surfaced here.
  const { port: ptyWebSocketPort } = resolveHeadlessServerConfig(config);

  return {
    currentUsername,
    projects,
    lastProjectId: lastProjectId ?? (projects.length > 0 ? String(projects[0].id) : 'all'),
    sidebarCollapsed,
    ptyWebSocketPort,
  };
};
