import { z } from 'zod';

export const phaseSchema = z
  .object({
    title: z.string(),
    goal: z.string(),
    details: z.string(),
    tasks: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
        files: z.array(z.string()),
        include_imports: z.boolean().default(false),
        include_importers: z.boolean().default(false),
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
    id: z.string(),
    status: z.enum(['pending', 'in_progress', 'done']).default('pending').optional(),
    priority: z.enum(['unknown', 'low', 'medium', 'high', 'urgent']).default('unknown').optional(),
    dependencies: z.array(z.string()).default([]).optional(),
    baseBranch: z.string().optional(),
    changedFiles: z.array(z.string()).default([]).optional(),
    rmfilter: z.array(z.string()).default([]).optional(),
    issue: z.array(z.string().url()).default([]).optional(),
    pullRequest: z.array(z.string().url()).default([]).optional(),
    planGeneratedAt: z.string().datetime().optional(),
    promptsGeneratedAt: z.string().datetime().optional(),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .describe('rmplan phase file schema');

export type PhaseSchema = z.infer<typeof phaseSchema>;

// Backward compatibility - export phaseSchema as planSchema
export const planSchema = phaseSchema;
export type PlanSchema = PhaseSchema;
