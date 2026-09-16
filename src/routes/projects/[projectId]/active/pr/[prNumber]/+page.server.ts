import { getServerContext } from '$lib/server/init.js';
import { loadChatExecutorOptionsForProject } from '$lib/server/plans_browser.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const { db } = await getServerContext();
  return {
    chatExecutorOptions: await loadChatExecutorOptionsForProject(db, Number(params.projectId)),
  };
};
