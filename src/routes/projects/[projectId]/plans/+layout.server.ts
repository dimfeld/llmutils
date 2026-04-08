import { getServerContext } from '$lib/server/init.js';
import { getIssueTrackerStatus } from '$lib/server/issue_import.js';
import { getPlansPageData } from '$lib/server/plans_browser.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ parent }) => {
  const { projectId } = await parent();
  const { db } = await getServerContext();

  let issueTrackerAvailable = false;
  if (projectId !== 'all') {
    try {
      const status = await getIssueTrackerStatus(db, Number(projectId));
      issueTrackerAvailable = status.available;
    } catch (e) {
      // Don't break the plans page if tracker status check fails
      console.error(e);
    }
  }

  return {
    ...(await getPlansPageData(db, projectId)),
    issueTrackerAvailable,
  };
};
