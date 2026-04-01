import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAllTimCaches } from '../../testing.js';
import { getDefaultConfig } from '../configSchema.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { writePlanToDb } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import type { TimConfig } from '../configSchema.js';
import type { ToolContext } from './context.js';
import { listReadyPlansTool } from './list_ready_plans.js';

describe('listReadyPlansTool', () => {
  let tempDir: string;
  let tasksDir: string;
  let config: TimConfig;
  let context: ToolContext;

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-list-ready-plans-test-'));
    tasksDir = path.join(tempDir, 'tasks');

    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/test/${path.basename(tempDir)}.git`
      .cwd(tempDir)
      .quiet();

    config = {
      ...getDefaultConfig(),
    };

    context = {
      config,
      gitRoot: tempDir,
    };
  });

  afterEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function seedPlan(plan: Partial<PlanSchema> & Pick<PlanSchema, 'id' | 'title'>) {
    await writePlanToDb(
      {
        id: plan.id,
        uuid: plan.uuid,
        title: plan.title,
        goal: plan.goal ?? '',
        details: plan.details ?? '',
        status: plan.status ?? 'pending',
        priority: plan.priority,
        parent: plan.parent,
        dependencies: plan.dependencies ?? [],
        discoveredFrom: plan.discoveredFrom,
        assignedTo: plan.assignedTo,
        issue: plan.issue ?? [],
        docs: plan.docs ?? [],
        tags: plan.tags ?? [],
        epic: plan.epic ?? false,
        temp: plan.temp ?? false,
        tasks: plan.tasks ?? [],
        references: plan.references,
        createdAt: plan.createdAt ?? new Date().toISOString(),
        updatedAt: plan.updatedAt ?? new Date().toISOString(),
        filename: plan.filename,
      },
      { cwdForIdentity: tempDir, skipUpdatedAt: true }
    );
  }

  test('returns an empty filename for DB-only ready plans', async () => {
    await seedPlan({
      id: 1,
      title: 'DB only plan',
      priority: 'high',
      tasks: [],
    });

    const result = await listReadyPlansTool({ pendingOnly: false }, context);

    expect(result.data).toBeDefined();
    expect(result.data?.count).toBe(1);
    expect(result.data?.plans[0]).toMatchObject({
      id: 1,
      title: 'DB only plan',
      filename: '',
      needsGenerate: true,
    });
    expect(JSON.parse(result.text).plans[0].filename).toBe('');
  });

  test('omits filename details for ready plans output', async () => {
    const existingFile = path.join(tasksDir, '2-existing.plan.md');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(existingFile, 'placeholder');

    await seedPlan({
      id: 2,
      title: 'File backed plan',
      priority: 'medium',
      filename: path.join('tasks', path.basename(existingFile)),
      tasks: [],
    });

    const result = await listReadyPlansTool({ pendingOnly: false }, context);
    const plan = result.data?.plans.find((entry) => entry.id === 2);

    expect(plan).toBeDefined();
    expect(plan?.filename).toBe('');
  });
});
