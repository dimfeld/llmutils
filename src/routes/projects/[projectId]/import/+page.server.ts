import { redirect } from '@sveltejs/kit';
import { getServerContext } from '$lib/server/init.js';
import { getIssueTrackerStatus } from '$lib/server/issue_import.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
  const { projectId } = await parent();

  if (projectId === 'all') {
    redirect(302, `/projects/${projectId}/plans`);
  }

  const numericProjectId = Number(projectId);
  if (!Number.isFinite(numericProjectId)) {
    redirect(302, `/projects/all/plans`);
  }

  // currentProject may be null when the parent layout resolved the project
  // via DB fallback. Look it up directly in that case.
  const { db } = await getServerContext();

  let trackerStatus;
  try {
    trackerStatus = await getIssueTrackerStatus(db, numericProjectId);
  } catch (e) {
    console.error(e);
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
