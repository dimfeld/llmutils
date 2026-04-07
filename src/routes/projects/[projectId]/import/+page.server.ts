import { redirect } from '@sveltejs/kit';
import { getIssueTrackerStatus } from '$lib/server/issue_import.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
  const { projectId, currentProject } = await parent();

  if (projectId === 'all' || !currentProject?.last_git_root) {
    redirect(302, `/projects/${projectId}/plans`);
  }

  const numericProjectId = Number(projectId);
  if (!Number.isFinite(numericProjectId)) {
    redirect(302, `/projects/all/plans`);
  }

  let trackerStatus;
  try {
    trackerStatus = await getIssueTrackerStatus(currentProject.last_git_root);
  } catch {
    redirect(302, `/projects/${projectId}/plans`);
  }

  if (!trackerStatus.available) {
    redirect(302, `/projects/${projectId}/plans`);
  }

  return {
    trackerType: trackerStatus.trackerType,
    displayName: trackerStatus.displayName,
    supportsHierarchical: trackerStatus.supportsHierarchical,
    numericProjectId,
  };
};
