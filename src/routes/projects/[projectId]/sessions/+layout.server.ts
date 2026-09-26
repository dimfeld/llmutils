import type { LayoutServerLoad } from './$types';
import { getServerContext } from '$lib/server/init.js';
import { loadChatExecutorOptionsForProject } from '$lib/server/plans_browser.js';
import { getPrimaryWorkspacePath } from '$tim/db/workspace.js';

export const load: LayoutServerLoad = async ({ params }) => {
  if (params.projectId === 'all') {
    return { chatExecutorOptions: [], hasPrimaryWorkspace: false };
  }

  const projectId = Number(params.projectId);
  const { db } = await getServerContext();
  return {
    chatExecutorOptions: await loadChatExecutorOptionsForProject(db, projectId),
    hasPrimaryWorkspace: getPrimaryWorkspacePath(db, projectId) != null,
  };
};
