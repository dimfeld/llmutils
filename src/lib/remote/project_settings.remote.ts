import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { PROJECT_COLOR_PALETTE } from '$lib/stores/project.svelte.js';
import { branchPrefixSchema } from '$tim/branch_prefix.js';
import { getProjectById } from '$tim/db/project.js';
import { deleteProjectSetting, setProjectSetting } from '$tim/db/project_settings.js';

const settingValueSchemas: Record<string, z.ZodType> = {
  featured: z.boolean(),
  abbreviation: z.string().max(4),
  color: z.enum(PROJECT_COLOR_PALETTE),
  branchPrefix: branchPrefixSchema,
};

const updateSettingSchema = z.object({
  projectId: z.number().int().positive(),
  setting: z.string().min(1),
  value: z.unknown().refine((v) => v !== undefined, 'Value must not be undefined'),
});

const updateSettingsSchema = z.object({
  projectId: z.number().int().positive(),
  settings: z.array(
    z.object({
      setting: z.string().min(1),
      value: z.unknown().refine((v) => v !== undefined, 'Value must not be undefined'),
    })
  ),
});

type ValidatedProjectSettingUpdate = {
  setting: string;
  value: unknown;
  clear: boolean;
};

function validateProjectExists(
  projectId: number,
  db: Awaited<ReturnType<typeof getServerContext>>['db']
) {
  const project = getProjectById(db, projectId);
  if (!project) {
    error(404, 'Project not found');
  }
}

function validateProjectSettingUpdate(
  setting: string,
  value: unknown
): ValidatedProjectSettingUpdate {
  const settingSchema = settingValueSchemas[setting];
  if (!settingSchema) {
    error(400, `Unknown setting: "${setting}"`);
  }

  const normalizedValue = typeof value === 'string' ? value.trim() : value;

  if (normalizedValue === '') {
    return {
      setting,
      value: null,
      clear: true,
    };
  }

  const result = settingSchema.safeParse(normalizedValue);
  if (!result.success) {
    error(400, `Invalid value for setting "${setting}": ${result.error.message}`);
  }

  return {
    setting,
    value: result.data,
    clear: false,
  };
}

export const updateProjectSetting = command(
  updateSettingSchema,
  async ({ projectId, setting, value }) => {
    const { db } = await getServerContext();

    validateProjectExists(projectId, db);
    const validatedUpdate = validateProjectSettingUpdate(setting, value);

    if (validatedUpdate.clear) {
      deleteProjectSetting(db, projectId, validatedUpdate.setting);
      return;
    }

    setProjectSetting(db, projectId, validatedUpdate.setting, validatedUpdate.value);
  }
);

export const updateProjectSettings = command(
  updateSettingsSchema,
  async ({ projectId, settings }) => {
    const { db } = await getServerContext();

    validateProjectExists(projectId, db);

    const validatedUpdates = settings.map(({ setting, value }) =>
      validateProjectSettingUpdate(setting, value)
    );

    const applyUpdates = db.transaction(
      (nextProjectId: number, nextSettings: ValidatedProjectSettingUpdate[]) => {
        for (const nextSetting of nextSettings) {
          if (nextSetting.clear) {
            deleteProjectSetting(db, nextProjectId, nextSetting.setting);
            continue;
          }

          setProjectSetting(db, nextProjectId, nextSetting.setting, nextSetting.value);
        }
      }
    );

    applyUpdates.immediate(projectId, validatedUpdates);
  }
);
