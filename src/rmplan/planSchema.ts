import { z } from 'zod';

export const phaseSchema = z
  .object({
    title: z.string().optional(),
    goal: z.string(),
    details: z.string(),
    id: z.string().optional(),
    status: z.enum(['pending', 'in_progress', 'done']).default('pending').optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    dependencies: z.array(z.string()).default([]).optional(),
    issue: z.array(z.string().url()).default([]).optional(),
    pullRequest: z.array(z.string().url()).default([]).optional(),
    planGeneratedAt: z.string().datetime().optional(),
    promptsGeneratedAt: z.string().datetime().optional(),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    project: z
      .object({
        title: z.string(),
        goal: z.string(),
        details: z.string(),
      })
      .optional(),
    tasks: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
        files: z.array(z.string()).default([]),
        examples: z.array(z.string()).optional(),
        steps: z
          .array(
            z.object({
              prompt: z.string(),
              examples: z.array(z.string()).optional(),
              done: z.boolean().default(false),
            })
          )
          .default([]),
      })
    ),
    baseBranch: z.string().optional(),
    changedFiles: z.array(z.string()).default([]).optional(),
    rmfilter: z.array(z.string()).default([]).optional(),
  })
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
  .describe('Multi-phase plan structure for split command');

export type MultiPhasePlanSchema = z.infer<typeof multiPhasePlanSchema>;
