import { z } from 'zod';

export const planSchema = z.object({
  goal: z.string(),
  details: z.string(),
  tasks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      files: z.array(z.string()),
      steps: z.array(
        z.object({
          prompt: z.string(),
          done: z.boolean().default(false),
        })
      ),
    })
  ),
});

export type PlanSchema = z.infer<typeof planSchema>;
