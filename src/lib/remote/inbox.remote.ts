import { command, query } from '$app/server';
import * as z from 'zod';

import { enrichInboxItems, type EnrichedInboxItem } from '$lib/server/inbox_enrichment.js';
import { getServerContext } from '$lib/server/init.js';
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

const markInboxItemsReadSchema = z.object({
  ids: z.array(z.number().int()),
});

export interface InboxItemsResponse {
  items: EnrichedInboxItem[];
  unreadCount: number;
}

export const getInboxItems = query(
  projectIdSchema,
  async ({ projectId }): Promise<InboxItemsResponse> => {
    const { db } = await getServerContext();
    const scope = projectId === 'all' ? 'all' : Number(projectId);
    const rows = listRecentInboxItems(db, {
      projectId: scope,
      limit: 50,
      includeRead: false,
    });

    return {
      items: enrichInboxItems(db, rows),
      unreadCount: countUnreadInboxItems(db, { projectId: scope }),
    };
  }
);

async function refreshInboxQueries(projectId?: string): Promise<void> {
  await getInboxItems({ projectId: 'all' }).refresh();
  if (projectId !== undefined) {
    await getInboxItems({ projectId }).refresh();
  }
}

export const markInboxItemsRead = command(
  markInboxItemsReadSchema,
  async ({ ids }): Promise<void> => {
    const { db } = await getServerContext();
    markInboxItemsReadRows(db, ids);
    await refreshInboxQueries();
  }
);

export const markAllInboxItemsRead = command(
  projectIdSchema,
  async ({ projectId }): Promise<void> => {
    const { db } = await getServerContext();
    const options = {
      cutoff: new Date().toISOString(),
      ...(projectId === 'all' ? {} : { projectId: Number(projectId) }),
    };
    markAllReadBefore(db, options);
    await refreshInboxQueries(projectId === 'all' ? undefined : projectId);
  }
);

export const dismissInboxItem = command(
  z.object({ id: z.number().int() }),
  async ({ id }): Promise<void> => {
    const { db } = await getServerContext();
    dismissInboxItemRow(db, id);
    await refreshInboxQueries();
  }
);
