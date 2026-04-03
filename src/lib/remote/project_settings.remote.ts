import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { getProjectById } from '$tim/db/project.js';
import { setProjectSetting } from '$tim/db/project_settings.js';

const settingValueSchemas: Record<string, z.ZodType> = {
  featured: z.boolean(),
};

const updateSettingSchema = z.object({
  projectId: z.number().int().positive(),
  setting: z.string().min(1),
  value: z.unknown().refine((v) => v !== undefined, 'Value must not be undefined'),
});

export const updateProjectSetting = command(
  updateSettingSchema,
  async ({ projectId, setting, value }) => {
    const { db } = await getServerContext();

    const project = getProjectById(db, projectId);
    if (!project) {
      error(404, 'Project not found');
    }

    const settingSchema = settingValueSchemas[setting];
    if (!settingSchema) {
      error(400, `Unknown setting: "${setting}"`);
    }

    const result = settingSchema.safeParse(value);
    if (!result.success) {
      error(400, `Invalid value for setting "${setting}": ${result.error.message}`);
    }

    setProjectSetting(db, projectId, setting, result.data);
  }
);
