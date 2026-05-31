import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
  const { projectId } = await parent();

  if (projectId === 'all') {
    redirect(302, `/projects/all/plans`);
  }

  const numericProjectId = Number(projectId);
  if (!Number.isFinite(numericProjectId)) {
    redirect(302, `/projects/all/plans`);
  }

  return {
    numericProjectId,
  };
};
