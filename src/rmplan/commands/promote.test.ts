import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handlePromoteCommand } from './promote.js';
import { clearPlanCache, readPlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock console functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});

describe('handlePromoteCommand', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-promote-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock modules
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: mock(() => {}),
      debugLog: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
      })),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function createPlanFile(id: string, plan: PlanSchema): Promise<string> {
    const planPath = path.join(tasksDir, `${id}.yml`);
    const yamlContent = yaml.stringify(plan);
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';
    await fs.writeFile(planPath, schemaLine + yamlContent);
    return planPath;
  }

  test('should promote a single task to a new top-level plan', async () => {
    // Create a sample plan with multiple tasks
    const originalPlan: PlanSchema = {
      id: 1,
      goal: 'Implement authentication system',
      details: 'Add user login and registration functionality',
      status: 'pending',
      tasks: [
        {
          title: 'Set up database schema',
          description: 'Create user table and authentication fields',
          steps: [],
        },
        {
          title: 'Implement login endpoint',
          description: 'Create API endpoint for user authentication',
          steps: [],
        },
        {
          title: 'Add password hashing',
          description: 'Implement secure password storage',
          steps: [],
        },
      ],
      dependencies: [],
    };

    await createPlanFile('1', originalPlan);

    // Promote the second task (1.2)
    await handlePromoteCommand(['1.2'], {});

    // Check that the new plan file was created (should be 2.yml)
    const newPlanPath = path.join(tasksDir, '2.yml');
    const newPlanExists = await fs
      .access(newPlanPath)
      .then(() => true)
      .catch(() => false);
    expect(newPlanExists).toBe(true);

    // Read and verify the new plan content
    const newPlan = await readPlanFile(newPlanPath);
    expect(newPlan.id).toBe(2);
    expect(newPlan.goal).toBe('Implement login endpoint');
    expect(newPlan.details).toBe('Create API endpoint for user authentication');
    expect(newPlan.tasks).toEqual([]);
    expect(newPlan.status).toBe('pending');

    // Read and verify the original plan was updated
    const updatedOriginalPlan = await readPlanFile(path.join(tasksDir, '1.yml'));
    expect(updatedOriginalPlan.tasks).toHaveLength(2);
    expect(updatedOriginalPlan.tasks![0].title).toBe('Set up database schema');
    expect(updatedOriginalPlan.tasks![1].title).toBe('Add password hashing');
    expect(updatedOriginalPlan.dependencies).toContain('2');

    // Verify logging was called
    expect(logSpy).toHaveBeenCalled();
  });
});
