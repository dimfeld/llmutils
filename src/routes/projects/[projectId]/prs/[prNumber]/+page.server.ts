import { getServerContext } from '$lib/server/init.js';
import {
  loadChatExecutorOptionsForProject,
  loadPrFixExecutorOptionsForProject,
} from '$lib/server/plans_browser.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const { db } = await getServerContext();
  const projectId = Number(params.projectId);
  return {
    chatExecutorOptions: await loadChatExecutorOptionsForProject(db, projectId),
    prFixExecutorOptions: await loadPrFixExecutorOptionsForProject(db, projectId),
  };
};
