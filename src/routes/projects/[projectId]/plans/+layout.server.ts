import { getServerContext } from '$lib/server/init.js';
import { getIssueTrackerStatus } from '$lib/server/issue_import.js';
import { getPlansPageData } from '$lib/server/plans_browser.js';
import { getProjectById } from '$tim/db/project.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ parent }) => {
  const { projectId, currentProject } = await parent();
  const { db } = await getServerContext();

  let issueTrackerAvailable = false;
  if (projectId !== 'all') {
    // currentProject may be null when the parent layout resolved the project
    // via DB fallback. Look it up directly in that case.
    const project = currentProject ?? getProjectById(db, Number(projectId));
    if (project?.last_git_root) {
      try {
        const status = await getIssueTrackerStatus(project.last_git_root);
        issueTrackerAvailable = status.available;
      } catch {
        // Don't break the plans page if tracker status check fails
      }
    }
  }

  return {
    ...getPlansPageData(db, projectId),
    issueTrackerAvailable,
  };
};
