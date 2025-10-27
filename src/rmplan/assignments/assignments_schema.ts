import { z } from 'zod/v4';

import { statusSchema } from '../planSchema.js';

const nonEmptyString = z
  .string()
  .min(1, { message: 'Value must not be empty' })
  .trim()
  .describe('Non-empty string value');

export const assignmentEntrySchema = z
  .object({
    planId: z
      .union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)])
      .transform((value) => (typeof value === 'string' ? Number(value) : value))
      .optional(),
    workspacePaths: z
      .array(nonEmptyString)
      .default([])
      .describe('Absolute workspace paths that have claimed the plan'),
    workspaceOwners: z
      .record(nonEmptyString, nonEmptyString)
      .optional()
      .describe('Mapping of workspace paths to the user that claimed them'),
    users: z.array(nonEmptyString).default([]).describe('Users that have claimed the plan'),
    status: statusSchema.optional(),
    assignedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough()
  .describe('Assignment entry for a specific plan UUID');

export const assignmentsFileSchema = z
  .object({
    repositoryId: nonEmptyString,
    repositoryRemoteUrl: z.string().min(1).optional().nullable(),
    version: z.number().int().nonnegative(),
    assignments: z.record(z.string().uuid(), assignmentEntrySchema),
  })
  .passthrough()
  .describe('Shared rmplan assignments file structure');

export type AssignmentEntry = z.output<typeof assignmentEntrySchema>;
export type AssignmentsFile = z.output<typeof assignmentsFileSchema>;
