import { redirect } from '@sveltejs/kit';
import { getServerContext } from '$lib/server/init.js';
import { setLastProjectId } from '$lib/stores/project.svelte.js';
import { getProjectById } from '$tim/db/project.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ params, cookies, parent, url }) => {
  const { projects } = await parent();
  const projectIdParam = params.projectId;

  let projectId: number | 'all';
  let currentProject = null;

  if (projectIdParam === 'all') {
    projectId = 'all';
  } else {
    const numId = Number(projectIdParam);
    const tab = url.pathname.split('/')[3] ?? 'sessions';

    if (!Number.isFinite(numId)) {
      redirect(302, `/projects/all/${tab}`);
    }

    currentProject = projects.find((p) => p.id === numId) ?? null;
    if (!currentProject) {
      // Project may not be in the parent layout data yet.
      // Fall back to a direct DB lookup so the route remains accessible.
      const { db } = await getServerContext();
      const dbProject = getProjectById(db, numId);
      if (!dbProject) {
        redirect(302, `/projects/all/${tab}`);
      }
    }

    projectId = numId;
  }

  setLastProjectId(cookies, projectId);

  return {
    projectId: String(projectId),
    currentProject,
  };
};
