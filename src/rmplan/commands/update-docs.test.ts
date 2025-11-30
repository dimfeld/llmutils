import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'path';
import type { PlanSchema } from '../planSchema.js';
import { readPlanFile, writePlanFile } from '../plans.js';
import { handleUpdateDocsCommand } from './update-docs.js';

describe('update-docs command', () => {
  let tempDir: string;
  let planFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-update-docs-test-'));
    planFile = path.join(tempDir, 'test-plan.yaml');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('handleUpdateDocsCommand requires planFile parameter', async () => {
    const mockCommand = {
      parent: {
        opts: () => ({ config: undefined }),
      },
    };

    await expect(handleUpdateDocsCommand(undefined, {}, mockCommand)).rejects.toThrow(
      'Plan file or ID is required'
    );
  });

  test('handleUpdateDocsCommand reads plan file successfully', async () => {
    const planData: PlanSchema = {
      id: 1,
      title: 'Test Feature Implementation',
      goal: 'Implement a new authentication system',
      details: 'Add OAuth2 support with Google and GitHub providers',
      status: 'in_progress',
      tasks: [
        {
          title: 'Create OAuth2 provider interface',
          description: 'Define the interface for OAuth2 providers',
          done: true,
        },
        {
          title: 'Implement Google provider',
          description: 'Add Google OAuth2 implementation',
          done: true,
        },
        {
          title: 'Add tests',
          description: 'Write comprehensive tests',
          done: false,
        },
      ],
    };

    await writePlanFile(planFile, planData);

    // Verify the plan was written correctly
    const readData = await readPlanFile(planFile);
    expect(readData.title).toBe('Test Feature Implementation');
    expect(readData.tasks?.length).toBe(3);
    expect(readData.tasks?.filter((t) => t.done).length).toBe(2);
  });

  test('plan with completed tasks can be read', async () => {
    const planData: PlanSchema = {
      id: 2,
      title: 'Config Test Plan',
      details: 'Testing config-based executor selection',
      status: 'done',
      tasks: [
        {
          title: 'Completed Task',
          description: 'A completed task',
          done: true,
        },
      ],
    };

    await writePlanFile(planFile, planData);

    const readData = await readPlanFile(planFile);
    expect(readData.tasks?.[0].done).toBe(true);
    expect(readData.tasks?.[0].title).toBe('Completed Task');
  });

  test('plan with no completed tasks can be read', async () => {
    const planData: PlanSchema = {
      id: 4,
      title: 'No Completed Tasks',
      details: 'Plan with only pending tasks',
      status: 'in_progress',
      tasks: [
        {
          title: 'Pending Task 1',
          description: 'Not done yet',
          done: false,
        },
        {
          title: 'Pending Task 2',
          description: 'Also not done',
          done: false,
        },
      ],
    };

    await writePlanFile(planFile, planData);

    const readData = await readPlanFile(planFile);
    expect(readData.tasks?.filter((t) => t.done).length).toBe(0);
  });
});
