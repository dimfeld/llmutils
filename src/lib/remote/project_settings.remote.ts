import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod/v4';

import { getServerContext } from '$lib/server/init.js';
import { PROJECT_COLOR_PALETTE } from '$lib/stores/project.svelte.js';
import { branchPrefixSchema } from '$tim/branch_prefix.js';
import { getProjectById } from '$tim/db/project.js';
import { deleteProjectSettingOperation, setProjectSettingOperation } from '$tim/sync/operations.js';
import {
  beginSyncBatch,
  getProjectUuidForId,
  writeProjectSettingDelete,
  writeProjectSettingSet,
} from '$tim/sync/write_router.js';

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
  baseRevision: z.number().int().nonnegative(),
});

const updateSettingsSchema = z.object({
  projectId: z.number().int().positive(),
  settings: z.array(
    z.object({
      setting: z.string().min(1),
      value: z.unknown().refine((v) => v !== undefined, 'Value must not be undefined'),
      baseRevision: z.number().int().nonnegative(),
    })
  ),
});

type ValidatedProjectSettingUpdate = {
  setting: string;
  value: unknown;
  baseRevision: number;
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
  value: unknown,
  baseRevision: number
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
      baseRevision,
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
    baseRevision,
    clear: false,
  };
}

export const updateProjectSetting = command(
  updateSettingSchema,
  async ({ projectId, setting, value, baseRevision }) => {
    const { db, config } = await getServerContext();

    validateProjectExists(projectId, db);
    const validatedUpdate = validateProjectSettingUpdate(setting, value, baseRevision);

    if (validatedUpdate.clear) {
      await writeProjectSettingDelete(
        db,
        config,
        projectId,
        validatedUpdate.setting,
        validatedUpdate.baseRevision
      );
      return;
    }

    await writeProjectSettingSet(
      db,
      config,
      projectId,
      validatedUpdate.setting,
      validatedUpdate.value,
      validatedUpdate.baseRevision
    );
  }
);

export const updateProjectSettings = command(
  updateSettingsSchema,
  async ({ projectId, settings }) => {
    const { db, config } = await getServerContext();

    validateProjectExists(projectId, db);

    const validatedUpdates = settings.map(({ setting, value, baseRevision }) =>
      validateProjectSettingUpdate(setting, value, baseRevision)
    );

    const projectUuid = getProjectUuidForId(db, projectId);
    const batch = await beginSyncBatch(db, config, {
      reason: 'project_settings_update',
      atomic: true,
    });
    for (const nextSetting of validatedUpdates) {
      if (nextSetting.clear) {
        batch.add((options) =>
          deleteProjectSettingOperation(
            {
              projectUuid,
              setting: nextSetting.setting,
              baseRevision: nextSetting.baseRevision,
            },
            options
          )
        );
        continue;
      }

      batch.add((options) =>
        setProjectSettingOperation(
          {
            projectUuid,
            setting: nextSetting.setting,
            value: nextSetting.value,
            baseRevision: nextSetting.baseRevision,
          },
          options
        )
      );
    }

    await batch.commit();
  }
);
