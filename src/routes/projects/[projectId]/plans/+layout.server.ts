import { getServerContext } from '$lib/server/init.js';
import { getPlansPageData } from '$lib/server/plans_browser.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ parent }) => {
  const { projectId } = await parent();
  const { db } = await getServerContext();

  return getPlansPageData(db, projectId);
};
