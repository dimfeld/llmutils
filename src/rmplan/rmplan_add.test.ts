import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { $ } from 'bun';
import type { PlanSchema } from './planSchema.js';

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

    // The file should be named 1.yml since no plans exist
    const planPath = path.join(tasksDir, '1.yml');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const content = await fs.readFile(planPath, 'utf-8');
    const yamlContent = content.replace(/^#\s*yaml-language-server:.*$/m, '').trim();
    const plan = yaml.parse(yamlContent) as PlanSchema;

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

    // The file should be named 101.yml (max ID was 100)
    const planPath = path.join(tasksDir, '101.yml');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const content = await fs.readFile(planPath, 'utf-8');
    const yamlContent = content.replace(/^#\s*yaml-language-server:.*$/m, '').trim();
    const plan = yaml.parse(yamlContent) as PlanSchema;

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

    // The file should be named 6.yml (max numeric ID was 5)
    const planPath = path.join(tasksDir, '6.yml');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const content = await fs.readFile(planPath, 'utf-8');
    const yamlContent = content.replace(/^#\s*yaml-language-server:.*$/m, '').trim();
    const plan = yaml.parse(yamlContent) as PlanSchema;

    expect(plan.id).toBe(6);
    expect(plan.title).toBe('Another Plan');
  });

  test('handles multi-word titles correctly', async () => {
    // Run rmplan add command with multi-word title
    await $`bun ${path.join(process.cwd(), 'src/rmplan/rmplan.ts')} add This is a Multi Word Title --config ${path.join(tempDir, '.rmfilter', 'rmplan.yml')}`
      .cwd(tempDir)
      .text();

    // The file should be named 1.yml
    const planPath = path.join(tasksDir, '1.yml');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const content = await fs.readFile(planPath, 'utf-8');
    const yamlContent = content.replace(/^#\s*yaml-language-server:.*$/m, '').trim();
    const plan = yaml.parse(yamlContent) as PlanSchema;

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

    // The file should be named 3.yml
    const planPath = path.join(tasksDir, '3.yml');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const content = await fs.readFile(planPath, 'utf-8');
    const yamlContent = content.replace(/^#\s*yaml-language-server:.*$/m, '').trim();
    const plan = yaml.parse(yamlContent) as PlanSchema;

    expect(plan.id).toBe(3);
    expect(plan.title).toBe('Plan with Dependencies');
    expect(plan.dependencies).toEqual([1, 2]);
    expect(plan.priority).toBe('high');
  });
});
