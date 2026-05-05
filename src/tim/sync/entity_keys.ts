import * as z from 'zod/v4';

export const SyncEntityTypeSchema = z.enum(['project', 'plan', 'task', 'project_setting']);
export type SyncEntityType = z.infer<typeof SyncEntityTypeSchema>;

export const SyncUuidSchema = z.guid();
export const PROJECT_SETTING_NAME_PATTERN = /^[^\s:]+$/;

export function assertSyncUuid(value: string, label = 'uuid'): string {
  const result = SyncUuidSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid ${label}: expected UUID`);
  }
  return result.data;
}

export function projectKey(projectUuid: string): string {
  return `project:${assertSyncUuid(projectUuid, 'project UUID')}`;
}

export function planKey(planUuid: string): string {
  return `plan:${assertSyncUuid(planUuid, 'plan UUID')}`;
}

export function taskKey(taskUuid: string): string {
  return `task:${assertSyncUuid(taskUuid, 'task UUID')}`;
}

export function projectSettingKey(projectUuid: string, setting: string): string {
  if (!setting) {
    throw new Error('Invalid project setting key: setting must not be empty');
  }
  if (!PROJECT_SETTING_NAME_PATTERN.test(setting)) {
    if (setting.includes(':')) {
      throw new Error('Invalid project setting key: setting must not contain ":"');
    }
    throw new Error('Invalid project setting key: setting must not contain whitespace');
  }
  return `project_setting:${assertSyncUuid(projectUuid, 'project UUID')}:${setting}`;
}
