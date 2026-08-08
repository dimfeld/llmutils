import { command, query } from '$app/server';
import * as z from 'zod';

import { enrichInboxItems, type EnrichedInboxItem } from '$lib/server/inbox_enrichment.js';
import { getServerContext } from '$lib/server/init.js';
import { getSessionManager } from '$lib/server/session_context.js';
import {
  countUnreadInboxItems,
  dismissInboxItem as dismissInboxItemRow,
  listRecentInboxItems,
  markAllReadBefore,
  markInboxItemsRead as markInboxItemsReadRows,
} from '$tim/db/inbox_item.js';

export type {
  EnrichedInboxItem,
  InboxActionDescriptor,
  InboxActionType,
} from '$lib/server/inbox_enrichment.js';

const projectIdSchema = z.object({
  projectId: z.string().regex(/^(\d+|all)$/),
});

const inboxQuerySchema = z.object({
  projectId: z.string().regex(/^(\d+|all)$/),
  includeRead: z.boolean().optional(),
});

const markInboxItemsReadSchema = z.object({
  ids: z.array(z.number().int()),
});

export interface InboxItemsResponse {
  items: EnrichedInboxItem[];
  unreadCount: number;
}

export const getInboxItems = query(
  inboxQuerySchema,
  async ({ projectId, includeRead }): Promise<InboxItemsResponse> => {
    const { db } = await getServerContext();
    const scope = projectId === 'all' ? 'all' : Number(projectId);
    const rows = listRecentInboxItems(db, {
      projectId: scope,
      limit: includeRead ? 100 : 50,
      includeRead: includeRead ?? false,
    });

    return {
      items: enrichInboxItems(db, rows),
      unreadCount: countUnreadInboxItems(db, { projectId: scope }),
    };
  }
);

function emitInboxUpdateIfAvailable(projectIds: ReadonlyArray<number>): void {
  try {
    getSessionManager().emitInboxUpdate([...projectIds]);
  } catch {
    // Session manager may not be initialized in tests or during startup
  }
}

async function refreshInboxQueries(projectIds: ReadonlyArray<number>): Promise<void> {
  const scopes = [
    'all',
    ...Array.from(new Set(projectIds))
      .sort((left, right) => left - right)
      .map(String),
  ];

  await Promise.all(
    scopes.flatMap((projectId) => [
      getInboxItems({ projectId }).refresh(),
      getInboxItems({ projectId, includeRead: true }).refresh(),
    ])
  );
}

export const markInboxItemsRead = command(
  markInboxItemsReadSchema,
  async ({ ids }): Promise<void> => {
    const { db } = await getServerContext();
    const projectIds = markInboxItemsReadRows(db, ids);
    await refreshInboxQueries(projectIds);
    emitInboxUpdateIfAvailable(projectIds);
  }
);

export const markAllInboxItemsRead = command(
  projectIdSchema,
  async ({ projectId }): Promise<void> => {
    const { db } = await getServerContext();
    const options = {
      cutoff: new Date().toISOString(),
      ...(projectId === 'all' ? {} : { projectId: Number(projectId) }),
    } satisfies { cutoff: string; projectId?: number };
    const affectedProjectIds = markAllReadBefore(db, options);
    await refreshInboxQueries(affectedProjectIds);
    emitInboxUpdateIfAvailable(affectedProjectIds);
  }
);

export const dismissInboxItem = command(
  z.object({ id: z.number().int() }),
  async ({ id }): Promise<void> => {
    const { db } = await getServerContext();
    const projectIds = dismissInboxItemRow(db, id);
    await refreshInboxQueries(projectIds);
    emitInboxUpdateIfAvailable(projectIds);
  }
);
