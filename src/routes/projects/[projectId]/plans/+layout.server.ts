import { getServerContext } from '$lib/server/init.js';
import { getIssueTrackerStatus } from '$lib/server/issue_import.js';
import { getPlansPageData } from '$lib/server/plans_browser.js';
import { getPreferredProjectGitRoot } from '$tim/workspace/workspace_info.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ parent }) => {
  const { projectId } = await parent();
  const { db } = await getServerContext();

  let issueTrackerAvailable = false;
  if (projectId !== 'all') {
    const preferredGitRoot = getPreferredProjectGitRoot(db, Number(projectId));
    if (preferredGitRoot) {
      try {
        const status = await getIssueTrackerStatus(preferredGitRoot);
        issueTrackerAvailable = status.available;
      } catch (e) {
        // Don't break the plans page if tracker status check fails
        console.error(e);
      }
    }
  }

  return {
    ...(await getPlansPageData(db, projectId)),
    issueTrackerAvailable,
  };
};
