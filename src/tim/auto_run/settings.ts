import * as z from 'zod/v4';

export const AUTO_RUN_SETTING_KEY = 'autoRun';

export const autoRunSettingSchema = z
  .object({
    enabled: z.boolean(),
    maxConcurrent: z.number().int().positive().nullable(),
    runnerNodeId: z.string().min(1).optional(),
  })
  .refine((value) => !value.enabled || value.maxConcurrent !== null, {
    message: 'Set a concurrency limit before enabling automatic execution',
  });

export type AutoRunSetting = z.infer<typeof autoRunSettingSchema>;

export function parseAutoRunSetting(value: unknown): AutoRunSetting | null {
  const result = autoRunSettingSchema.safeParse(value);
  return result.success ? result.data : null;
}
