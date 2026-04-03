import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { getProjectById } from '$tim/db/project.js';
import { setProjectSetting } from '$tim/db/project_settings.js';

const updateSettingSchema = z.object({
  projectId: z.number().int().positive(),
  setting: z.string().min(1),
  value: z.unknown(),
});

export const updateProjectSetting = command(
  updateSettingSchema,
  async ({ projectId, setting, value }) => {
    const { db } = await getServerContext();

    const project = getProjectById(db, projectId);
    if (!project) {
      error(404, 'Project not found');
    }

    setProjectSetting(db, projectId, setting, value);
  }
);
