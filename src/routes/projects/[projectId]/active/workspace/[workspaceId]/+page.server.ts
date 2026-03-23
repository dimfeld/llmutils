import { error, redirect } from '@sveltejs/kit';
import { getServerContext } from '$lib/server/init.js';
import { getWorkspaceDetail } from '$lib/server/db_queries.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  if (!/^\d+$/.test(params.workspaceId)) {
    error(404, 'Invalid workspace ID');
  }
  const workspaceId = Number(params.workspaceId);

  const { db } = await getServerContext();
  const workspace = getWorkspaceDetail(db, workspaceId);

  if (!workspace) {
    error(404, 'Workspace not found');
  }

  if (params.projectId !== 'all' && String(workspace.projectId) !== params.projectId) {
    redirect(302, `/projects/${workspace.projectId}/active/workspace/${workspace.id}`);
  }

  return { workspace };
};
