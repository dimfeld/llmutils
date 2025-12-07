import { z } from 'zod/v4';

const nonEmptyString = z
  .string()
  .min(1, { message: 'Value must not be empty' })
  .trim()
  .describe('Non-empty string value');

export const sharedPermissionsFileSchema = z
  .object({
    repositoryId: nonEmptyString,
    version: z.number().int().nonnegative(),
    permissions: z.object({
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    }),
    updatedAt: z.string().datetime().optional(),
  })
  .passthrough()
  .describe('Shared permissions file structure for Claude Code approvals');

export type SharedPermissionsFile = z.output<typeof sharedPermissionsFileSchema>;
