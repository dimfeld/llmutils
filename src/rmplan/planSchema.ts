import { z } from 'zod/v4';

export const prioritySchema = z.enum(['low', 'medium', 'high', 'urgent', 'maybe']);
export type Priority = z.infer<typeof prioritySchema>;

export const statusSchema = z.enum(['pending', 'in_progress', 'done', 'cancelled', 'deferred']);

export const phaseSchema = z
  .object({
    title: z.string().optional(),
    goal: z.string(),
    details: z
      .string()
      .optional()
      .describe('Plan details. This can also be in markdown content after the YAML'),
    id: z.coerce.number().int().positive().optional(),
    status: statusSchema.default('pending').optional(),
    statusDescription: z.string().optional(),
    priority: prioritySchema.optional(),
    container: z.boolean().default(false).optional(),
    dependencies: z.array(z.coerce.number().int().positive()).default([]).optional(),
    parent: z.coerce.number().int().positive().optional(),
    issue: z.array(z.url()).default([]).optional(),
    pullRequest: z.array(z.url()).default([]).optional(),
    docs: z.array(z.string()).default([]).optional(),
    assignedTo: z.string().optional(),
    planGeneratedAt: z.string().datetime().optional(),
    promptsGeneratedAt: z.string().datetime().optional(),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    project: z
      .object({
        title: z.string(),
        goal: z.string(),
        details: z.string().optional(),
      })
      .strict()
      .optional(),
    tasks: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
        files: z.array(z.string()).default([]).optional(),
        examples: z.array(z.string()).optional(),
        docs: z.array(z.string()).default([]).optional(),
        done: z.boolean().default(false).optional(),
        steps: z
          .array(
            z.object({
              prompt: z.string(),
              examples: z.array(z.string()).optional(),
              done: z.boolean().default(false),
            }).strict()
          )
          .default([]),
      }).strict()
    ),
    baseBranch: z.string().optional(),
    changedFiles: z.array(z.string()).default([]).optional(),
    rmfilter: z.array(z.string()).default([]).optional(),
  })
  .strict()
  .describe('rmplan phase file schema');

export type PhaseSchema = z.infer<typeof phaseSchema>;

// Backward compatibility - export phaseSchema as planSchema
export const planSchema = phaseSchema;
export type PlanSchema = PhaseSchema;

// Multi-phase plan schema for split command
export const multiPhasePlanSchema = z
  .object({
    title: z.string().optional(),
    goal: z.string(),
    details: z.string().optional(),
    phases: z.array(phaseSchema),
  })
  .strict()
  .describe('Multi-phase plan structure for split command');

export type MultiPhasePlanSchema = z.infer<typeof multiPhasePlanSchema>;
