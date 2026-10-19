import { getServerContext } from '$lib/server/init.js';
import { loadPrFixExecutorOptionsForProject } from '$lib/server/plans_browser.js';
import { DEFAULT_CHAT_EXECUTOR_OPTIONS } from '$lib/utils/chat_executor_options.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  if (params.projectId === 'all') {
    return { prFixExecutorOptions: DEFAULT_CHAT_EXECUTOR_OPTIONS };
  }

  const { db } = await getServerContext();
  return {
    prFixExecutorOptions: await loadPrFixExecutorOptionsForProject(db, Number(params.projectId)),
  };
};
