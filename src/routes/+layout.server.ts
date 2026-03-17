import { getServerContext } from '$lib/server/init.js';
import { getProjectsWithMetadata } from '$lib/server/db_queries.js';
import { getLastProjectId } from '$lib/stores/project.svelte.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ cookies }) => {
  const { db } = await getServerContext();
  const projects = getProjectsWithMetadata(db);
  const lastProjectId = getLastProjectId(cookies);

  return {
    projects,
    lastProjectId: lastProjectId ?? (projects.length > 0 ? String(projects[0].id) : 'all'),
  };
};
