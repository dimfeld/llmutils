import { $ } from 'bun';
import { beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { readPlanFile } from '../plans.js';

describe('rmplan add command', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Create temporary directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-add-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Create config file that points to tasks directory
    const configPath = path.join(tempDir, '.rmfilter', 'rmplan.yml');
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

  test('creates plan with numeric ID when no plans exist', async () => {
    // Run rmplan add command
    const result =
      await $`bun ${path.join(process.cwd(), 'src/rmplan/rmplan.ts')} add "Test Title" --config ${path.join(tempDir, '.rmfilter', 'rmplan.yml')}`
        .cwd(tempDir)
        .text();

    // Check output mentions creation
    expect(result).toContain('Created plan stub:');

    // The file should be named 1-test-title.plan.md since no plans exist
    const planPath = path.join(tasksDir, '1-test-title.plan.md');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const plan = await readPlanFile(planPath);
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('Test Title');
    expect(plan.goal).toBe('');
    expect(plan.details).toBe('');
    expect(plan.status).toBe('pending');
    expect(plan.tasks).toEqual([]);
  });

  test('creates plan with next numeric ID when plans exist', async () => {
    // Create existing plan files with proper schema comment
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';

    await fs.writeFile(
      path.join(tasksDir, '50.yml'),
      schemaLine +
        yaml.stringify({
          id: 50,
          title: 'Existing Plan 50',
          goal: 'Test goal',
          details: 'Test details',
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        })
    );
    await fs.writeFile(
      path.join(tasksDir, '100.yml'),
      schemaLine +
        yaml.stringify({
          id: 100,
          title: 'Existing Plan 100',
          goal: 'Test goal',
          details: 'Test details',
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        })
    );

    // Run rmplan add command
    const result =
      await $`bun ${path.join(process.cwd(), 'src/rmplan/rmplan.ts')} add "New Plan Title" --config ${path.join(tempDir, '.rmfilter', 'rmplan.yml')}`
        .cwd(tempDir)
        .text();

    // The file should be named 101-new-plan-title.plan.md (max ID was 100)
    const planPath = path.join(tasksDir, '101-new-plan-title.plan.md');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const plan = await readPlanFile(planPath);
    expect(plan.id).toBe(101);
    expect(plan.title).toBe('New Plan Title');
  });

  test('creates plan with numeric ID ignoring non-numeric plan files', async () => {
    // Create existing plan files with non-numeric and numeric names
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';

    await fs.writeFile(
      path.join(tasksDir, 'old-plan.yml'),
      schemaLine +
        yaml.stringify({
          id: 'abc123',
          title: 'Old Alphanumeric Plan',
          goal: 'Test goal',
          details: 'Test details',
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        })
    );
    await fs.writeFile(
      path.join(tasksDir, '5.yml'),
      schemaLine +
        yaml.stringify({
          id: 5,
          title: 'Numeric Plan 5',
          goal: 'Test goal',
          details: 'Test details',
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        })
    );

    // Run rmplan add command
    await $`bun ${path.join(process.cwd(), 'src/rmplan/rmplan.ts')} add "Another Plan" --config ${path.join(tempDir, '.rmfilter', 'rmplan.yml')}`
      .cwd(tempDir)
      .text();

    // The file should be named 6-another-plan.plan.md (max numeric ID was 5)
    const planPath = path.join(tasksDir, '6-another-plan.plan.md');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const plan = await readPlanFile(planPath);
    expect(plan.id).toBe(6);
    expect(plan.title).toBe('Another Plan');
  });

  test('handles multi-word titles correctly', async () => {
    // Run rmplan add command with multi-word title
    await $`bun ${path.join(process.cwd(), 'src/rmplan/rmplan.ts')} add This is a Multi Word Title --config ${path.join(tempDir, '.rmfilter', 'rmplan.yml')}`
      .cwd(tempDir)
      .text();

    // The file should be named 1-this-is-a-multi-word-title.plan.md
    const planPath = path.join(tasksDir, '1-this-is-a-multi-word-title.plan.md');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const plan = await readPlanFile(planPath);
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('This is a Multi Word Title');
  });

  test('adds dependencies and priority correctly', async () => {
    // Create existing plans to depend on
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';

    await fs.writeFile(
      path.join(tasksDir, '1.yml'),
      schemaLine +
        yaml.stringify({
          id: 1,
          title: 'Dependency 1',
          goal: 'Test goal',
          details: 'Test details',
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        })
    );
    await fs.writeFile(
      path.join(tasksDir, '2.yml'),
      schemaLine +
        yaml.stringify({
          id: 2,
          title: 'Dependency 2',
          goal: 'Test goal',
          details: 'Test details',
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        })
    );

    // Run rmplan add command with dependencies and priority
    await $`bun ${path.join(process.cwd(), 'src/rmplan/rmplan.ts')} add "Plan with Dependencies" --depends-on 1 2 --priority high --config ${path.join(tempDir, '.rmfilter', 'rmplan.yml')}`
      .cwd(tempDir)
      .text();

    // The file should be named 3-plan-with-dependencies.plan.md
    const planPath = path.join(tasksDir, '3-plan-with-dependencies.plan.md');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const plan = await readPlanFile(planPath);

    expect(plan.id).toBe(3);
    expect(plan.title).toBe('Plan with Dependencies');
    expect(plan.dependencies).toEqual([1, 2]);
    expect(plan.priority).toBe('high');
  });

  test('creates plan with parent and updates parent dependencies', async () => {
    // Create a parent plan
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';

    const parentCreatedAt = new Date().toISOString();
    await fs.writeFile(
      path.join(tasksDir, '1-parent-plan.yml'),
      schemaLine +
        yaml.stringify({
          id: 1,
          title: 'Parent Plan',
          goal: 'Test parent goal',
          details: 'Test parent details',
          status: 'pending',
          createdAt: parentCreatedAt,
          updatedAt: parentCreatedAt,
          tasks: [],
        })
    );

    // Add a small delay to ensure timestamps are different
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Run rmplan add command with parent option
    const result =
      await $`bun ${path.join(process.cwd(), 'src/rmplan/rmplan.ts')} add "Child Plan" --parent 1 --config ${path.join(tempDir, '.rmfilter', 'rmplan.yml')}`
        .cwd(tempDir)
        .text();

    // Check output mentions creation and parent update
    expect(result).toContain('Created plan stub:');
    expect(result).toContain('Updated parent plan 1 to include dependency on 2');

    // The child file should be named 2-child-plan.plan.md
    const childPlanPath = path.join(tasksDir, '2-child-plan.plan.md');
    expect(
      await fs.access(childPlanPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify child plan content
    const childPlan = await readPlanFile(childPlanPath);
    expect(childPlan.id).toBe(2);
    expect(childPlan.title).toBe('Child Plan');
    expect(childPlan.parent).toBe(1);

    // Read and verify parent plan was updated
    const parentPlanPath = path.join(tasksDir, '1-parent-plan.yml');
    const parentPlan = await readPlanFile(parentPlanPath);
    expect(parentPlan.dependencies).toEqual([2]);
    expect(new Date(parentPlan.updatedAt!).getTime()).toBeGreaterThan(
      new Date(parentCreatedAt).getTime()
    );
  });

  test('errors when parent plan does not exist', async () => {
    // Run rmplan add command with non-existent parent
    const result =
      await $`bun ${path.join(process.cwd(), 'src/rmplan/rmplan.ts')} add "Orphan Plan" --parent 999 --config ${path.join(tempDir, '.rmfilter', 'rmplan.yml')}`
        .cwd(tempDir)
        .nothrow();

    // Should exit with error code
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr.toString()).toContain('Parent plan with ID 999 not found');
  });
});
