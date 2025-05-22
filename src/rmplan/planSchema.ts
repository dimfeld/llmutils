import { z } from 'zod';

export const planSchema = z
  .object({
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
        steps: z.array(
          z.object({
            prompt: z.string(),
            examples: z.array(z.string()).optional(),
            done: z.boolean().default(false),
          })
        ),
      })
    ),
  })
  .describe('rmplan plan file schema');

export type PlanSchema = z.infer<typeof planSchema>;
