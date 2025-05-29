import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'yaml';
import { phaseSchema } from './planSchema.js';

export interface PlanSummary {
  status?: 'pending' | 'in_progress' | 'done';
  priority?: 'unknown' | 'low' | 'medium' | 'high' | 'urgent';
  dependencies?: string[];
  goal: string;
  filename: string;
  createdAt?: string;
  updatedAt?: string;
}

export async function readAllPlans(directory: string): Promise<Map<string, PlanSummary>> {
  const plans = new Map<string, PlanSummary>();
  const promises: Promise<void>[] = [];

  async function readFile(fullPath: string) {
    try {
      const content = await Bun.file(fullPath).text();
      const parsed = yaml.parse(content);

      const result = phaseSchema.safeParse(parsed);
      if (result.success) {
        const plan = result.data;
        plans.set(plan.id, {
          status: plan.status,
          priority: plan.priority,
          dependencies: plan.dependencies,
          goal: plan.goal,
          filename: fullPath,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        });
      }
    } catch (error) {
      // Skip files that fail to parse or validate
      console.error(`Failed to read plan from ${fullPath}:`, error);
    }
  }

  async function scanDirectory(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        await scanDirectory(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml'))) {
        promises.push(readFile(fullPath));
      }
    }
  }

  await scanDirectory(directory);
  await Promise.all(promises);
  return plans;
}
