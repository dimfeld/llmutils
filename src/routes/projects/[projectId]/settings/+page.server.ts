import { redirect } from '@sveltejs/kit';
import { getServerContext } from '$lib/server/init.js';
import { getProjectSettings } from '$tim/db/project_settings.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  if (params.projectId === 'all') {
    redirect(302, '/projects/all/sessions');
  }

  const numericProjectId = Number(params.projectId);

  const { db } = await getServerContext();
  const settings = getProjectSettings(db, numericProjectId);

  return { settings };
};
