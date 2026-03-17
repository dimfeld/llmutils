import { redirect } from '@sveltejs/kit';
import { getLastProjectId } from '$lib/stores/project.svelte.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies, parent }) => {
  const { projects } = await parent();
  const lastProjectId = getLastProjectId(cookies);

  // Validate the cookie target exists
  let targetId = 'all';
  if (lastProjectId && lastProjectId !== 'all') {
    const numId = Number(lastProjectId);
    if (Number.isFinite(numId) && projects.some((p) => p.id === numId)) {
      targetId = lastProjectId;
    }
  }

  redirect(302, `/projects/${targetId}/sessions`);
};
