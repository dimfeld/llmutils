import { redirect } from '@sveltejs/kit';
import { getServerContext } from '$lib/server/init.js';
import { getProjectSettingsWithMetadata } from '$tim/db/project_settings.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  if (params.projectId === 'all') {
    redirect(302, '/projects/all/sessions');
  }

  const numericProjectId = Number(params.projectId);

  const { db } = await getServerContext();
  const settingsWithMetadata = getProjectSettingsWithMetadata(db, numericProjectId);
  const settings = Object.fromEntries(
    Object.entries(settingsWithMetadata).map(([setting, metadata]) => [setting, metadata.value])
  );
  const settingMetadata = Object.fromEntries(
    Object.entries(settingsWithMetadata).map(([setting, metadata]) => [
      setting,
      {
        revision: metadata.revision,
        updatedAt: metadata.updatedAt,
        updatedByNode: metadata.updatedByNode,
      },
    ])
  );

  return { settings, settingMetadata };
};
