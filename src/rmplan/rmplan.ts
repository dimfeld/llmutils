#!/usr/bin/env bun
import { z } from 'zod';
import { planPrompt } from './prompt.js';

const planSchema = z.object({
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

const file = process.argv[2];
const plan = await Bun.file(file).text();
const parsedPlan = planPrompt(plan);
console.log(parsedPlan);
