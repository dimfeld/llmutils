import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { $ } from 'bun';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { clearPlanCache, readPlanFile } from './plans.js';
import type { PlanSchema } from './planSchema.js';

describe('rmplan CLI integration tests', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;
  const rmplanPath = path.join(__dirname, 'rmplan.ts');

  beforeEach(async () => {
    // Clear plan cache
    clearPlanCache();

    // Create temporary directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-integration-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Create config file
    configPath = path.join(tempDir, '.rmfilter', 'rmplan.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: {
          tasks: 'tasks',
        },
      })
    );
  });

  afterEach(async () => {
    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('rmplan add creates a new plan', async () => {
    const result = await $`bun ${rmplanPath} add "Integration Test Plan" --config ${configPath}`
      .env({ ...process.env, TEST_ALLOW_CONSOLE: 'true' })
      .cwd(tempDir)
      .text();

    expect(result).toContain('Created plan stub:');

    // Check that file was created
    const planFiles = await fs.readdir(tasksDir);
    expect(planFiles).toHaveLength(1);
    expect(planFiles[0]).toBe('1-integration-test-plan.plan.md');

    // Verify plan content
    const plan = await readPlanFile(path.join(tasksDir, '1-integration-test-plan.plan.md'));
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('Integration Test Plan');
  });

  test('rmplan list shows created plans', async () => {
    // Create a test plan
    const plan = {
      id: 1,
      title: 'List Test Plan',
      goal: 'Test listing',
      details: 'Details',
      status: 'pending',
      tasks: [],
    };
    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const result = await $`bun ${rmplanPath} list --config ${configPath}`
      .env({ ...process.env, TEST_ALLOW_CONSOLE: 'true' })
      .cwd(tempDir)
      .text();

    expect(result).toContain('List Test Plan');
    expect(result).toContain('pending');
  });

  test('rmplan show displays plan details', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Show Test Plan',
      goal: 'Test showing plan details',
      details: 'Detailed description of the plan',
      status: 'pending',
      priority: 'high',
      tasks: [
        {
          title: 'Task 1',
          description: 'First task',
          done: false,
          steps: [
            {
              prompt: 'Do step 1',
              done: false,
            },
          ],
        },
      ],
    };
    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const result = await $`bun ${rmplanPath} show 1 --config ${configPath}`
      .env({ ...process.env, TEST_ALLOW_CONSOLE: 'true' })
      .cwd(tempDir)
      .text();

    expect(result).toContain('Show Test Plan');
    expect(result).toContain('Test showing plan details');
    expect(result).toContain('Task 1');
    expect(result).toContain('Step 1');
  });

  test('rmplan done marks steps as complete', async () => {
    // Create a test plan with steps
    const plan: PlanSchema = {
      id: 1,
      title: 'Done Test Plan',
      goal: 'Test marking steps done',
      details: 'Details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task 1',
          description: 'First task',
          done: false,
          steps: [
            {
              prompt: 'Do step 1',
              done: false,
            },
            {
              prompt: 'Do step 2',
              done: false,
            },
          ],
        },
      ],
    };
    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const result = await $`bun ${rmplanPath} done 1 --steps 1 --config ${configPath}`
      .env({ ...process.env, TEST_ALLOW_CONSOLE: 'true' })
      .cwd(tempDir)
      .text();

    expect(result).toContain('Marked 1 step done');

    // Verify the step was marked as done
    const updatedPlan = await readPlanFile(path.join(tasksDir, '1.yml'));

    // The plan should have tasks with steps
    expect(updatedPlan.tasks).toBeDefined();
    expect(updatedPlan.tasks.length).toBeGreaterThan(0);
    expect(updatedPlan.tasks[0].steps).toBeDefined();
    expect(updatedPlan.tasks[0].steps.length).toBeGreaterThan(0);

    // Check step status
    expect(updatedPlan.tasks[0].steps[0].done).toBe(true);
    expect(updatedPlan.tasks[0].steps[1].done).toBe(false);
  });

  test('rmplan list --status filters by status', async () => {
    // Create plans with different statuses
    const plans = [
      {
        id: 1,
        title: 'Pending Plan',
        goal: 'Test',
        details: 'Details',
        status: 'pending',
        tasks: [],
      },
      {
        id: 2,
        title: 'Done Plan',
        goal: 'Test',
        details: 'Details',
        status: 'done',
        tasks: [],
      },
      {
        id: 3,
        title: 'In Progress Plan',
        goal: 'Test',
        details: 'Details',
        status: 'in_progress',
        tasks: [],
      },
    ];

    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    // Test filtering by done status
    const result = await $`bun ${rmplanPath} list --status done --config ${configPath}`
      .env({ ...process.env, TEST_ALLOW_CONSOLE: 'true' })
      .cwd(tempDir)
      .text();

    expect(result).toContain('Done Plan');
    expect(result).not.toContain('Pending Plan');
    expect(result).not.toContain('In Progress Plan');
  });

  test('rmplan show --next finds next ready plan', async () => {
    // Clear the plan cache again to be sure
    clearPlanCache();

    // Create plans with dependencies
    const plans = [
      {
        id: 1,
        title: 'Completed Dependency',
        goal: 'Already done',
        details: 'Details',
        status: 'done',
        tasks: [],
      },
      {
        id: 2,
        title: 'Ready Plan',
        goal: 'Ready to start',
        details: 'Details',
        status: 'pending',
        dependencies: [1],
        tasks: [],
      },
      {
        id: 3,
        title: 'Blocked Plan',
        goal: 'Blocked by dependencies',
        details: 'Details',
        status: 'pending',
        dependencies: [2],
        tasks: [],
      },
    ];

    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const result = await $`bun ${rmplanPath} show --next --config ${configPath}`
      .env({ ...process.env, TEST_ALLOW_CONSOLE: 'true' })
      .cwd(tempDir)
      .text();

    expect(result).toContain('Found next ready plan: 2');
    expect(result).toContain('Ready Plan');
  });

  test('rmplan add with dependencies and priority', async () => {
    // First create a plan to depend on
    await $`bun ${rmplanPath} add "First Plan" --config ${configPath}`.cwd(tempDir);

    // Create a plan with dependencies and priority
    const result =
      await $`bun ${rmplanPath} add "Dependent Plan" --depends-on 1 --depends-on 3 --priority high --config ${configPath} --debug`
        .env({ ...process.env, TEST_ALLOW_CONSOLE: 'true' })
        .cwd(tempDir)
        .text();

    expect(result).toContain('Created plan stub:');

    // Verify the plan has dependencies and priority
    const plan = await readPlanFile(path.join(tasksDir, '2-dependent-plan.plan.md'));
    expect(plan.id).toBe(2);
    expect(plan.dependencies).toEqual([1, 3]);
    expect(plan.priority).toBe('high');
  });
});
