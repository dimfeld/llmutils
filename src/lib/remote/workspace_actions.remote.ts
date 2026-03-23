import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';
import os from 'node:os';

import { getServerContext } from '$lib/server/init.js';
import { getWorkspaceById } from '$tim/db/workspace.js';
import { acquireWorkspaceLock, releaseWorkspaceLock } from '$tim/db/workspace_lock.js';

const workspaceIdSchema = z.object({
  workspaceId: z.number().int().positive(),
});

export const lockWorkspace = command(workspaceIdSchema, async ({ workspaceId }) => {
  const { db } = await getServerContext();

  const workspace = getWorkspaceById(db, workspaceId);
  if (!workspace) {
    error(404, 'Workspace not found');
  }

  try {
    acquireWorkspaceLock(db, workspaceId, {
      lockType: 'persistent',
      hostname: os.hostname(),
      command: 'web: manual lock',
    });
  } catch (err) {
    if ((err as Error).message?.includes('already locked')) {
      error(409, 'Workspace is already locked');
    }
    throw err;
  }
});

export const unlockWorkspace = command(workspaceIdSchema, async ({ workspaceId }) => {
  const { db } = await getServerContext();

  const workspace = getWorkspaceById(db, workspaceId);
  if (!workspace) {
    error(404, 'Workspace not found');
  }

  const released = releaseWorkspaceLock(db, workspaceId, { force: true });
  if (!released) {
    error(404, 'No lock found for this workspace');
  }
});
