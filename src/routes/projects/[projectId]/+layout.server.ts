import { redirect } from '@sveltejs/kit';
import { setLastProjectId } from '$lib/stores/project.svelte.js';
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
      redirect(302, `/projects/all/${tab}`);
    }

    projectId = numId;
  }

  setLastProjectId(cookies, projectId);

  return {
    projectId: String(projectId),
    currentProject,
  };
};
