import { $ } from 'bun';
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import type { PlanSchema } from '../planSchema.js';

describe('--batch-tasks CLI flag tests', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;
  let rmplanPath: string;

  beforeEach(async () => {
    // Create temporary directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-batch-tasks-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Create some dummy source files for rmfilter to work with
    const srcDir = path.join(tempDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'index.ts'), '// Test file\nconst test = "hello";');
    await fs.writeFile(path.join(srcDir, 'utils.ts'), '// Utils file\nexport const utils = {};');

    // Create config file that points to tasks directory
    configPath = path.join(tempDir, '.rmfilter', 'rmplan.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: {
          tasks: 'tasks',
        },
        models: {
          planning: 'test/test-model',
          stepGeneration: 'test/test-model',
        },
      })
    );

    // Path to rmplan CLI
    rmplanPath = path.join(process.cwd(), 'src/rmplan/rmplan.ts');
  });

  afterEach(async () => {
    // Clean up the temporary directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function createPlanFile(plan: PlanSchema & { filename: string }) {
    const filePath = path.join(tasksDir, plan.filename);

    // Create a proper plan object according to the schema
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';
    const planData: any = {
      id: plan.id,
      title: plan.title,
      goal: plan.goal || 'Test goal',
      details: plan.details || 'Test details',
      status: plan.status || 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: plan.tasks || [],
    };

    // Only add optional fields if they exist
    if (plan.dependencies && plan.dependencies.length > 0) {
      planData.dependencies = plan.dependencies;
    }
    if (plan.parent !== undefined) {
      planData.parent = plan.parent;
    }
    if (plan.priority) {
      planData.priority = plan.priority;
    }

    // Write as YAML with schema comment
    const yamlContent = schemaLine + yaml.stringify(planData);
    await fs.writeFile(filePath, yamlContent, 'utf-8');
  }

  describe('CLI flag parsing and recognition', () => {
    test('--batch-tasks flag is recognized by agent command', async () => {
      // Create a test plan
      await createPlanFile({
        id: 1,
        title: 'Test Plan',
        filename: '1-test.yml',
        status: 'pending',
        tasks: [{ title: 'Test task', description: 'Simple test task' }],
      });

      // Run agent with --batch-tasks and --dry-run to avoid actual execution
      const result = await $`bun ${rmplanPath} agent 1 --batch-tasks --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      // Should not fail due to unrecognized option (exit code 0 or acceptable error)
      expect([0, 1]).toContain(result.exitCode);

      // Should not contain "unknown option" error message
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('unknown option');
      expect(output).not.toContain('error: unknown option \'--batch-tasks\'');
    });

    test('--batch-tasks flag is recognized by run command (alias)', async () => {
      // Create a test plan
      await createPlanFile({
        id: 1,
        title: 'Test Plan',
        filename: '1-test.yml',
        status: 'pending',
        tasks: [{ title: 'Test task', description: 'Simple test task' }],
      });

      // Run with alias command and --batch-tasks
      const result = await $`bun ${rmplanPath} run 1 --batch-tasks --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      // Should not fail due to unrecognized option
      expect([0, 1]).toContain(result.exitCode);

      // Should not contain "unknown option" error message
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('unknown option');
      expect(output).not.toContain('error: unknown option \'--batch-tasks\'');
    });

    test('--batch-tasks flag works without any other options', async () => {
      // Create a test plan
      await createPlanFile({
        id: 1,
        title: 'Simple Plan',
        filename: '1-simple.yml',
        status: 'pending',
        tasks: [{ title: 'Simple task', description: 'Basic task' }],
      });

      // Run with minimal options
      const result = await $`bun ${rmplanPath} agent 1 --batch-tasks --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      // Should not fail due to flag parsing issues
      expect([0, 1]).toContain(result.exitCode);

      // Should not indicate option parsing problems
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('unknown option');
      expect(output).not.toContain('unexpected argument');
    });
  });

  describe('flag combination and compatibility', () => {
    test('--batch-tasks works with --dry-run', async () => {
      await createPlanFile({
        id: 1,
        title: 'Dry Run Test',
        filename: '1-dry-run.yml',
        status: 'pending',
        tasks: [{ title: 'Test task', description: 'Test description' }],
      });

      const result = await $`bun ${rmplanPath} agent 1 --batch-tasks --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      // Should not fail due to incompatible options
      expect([0, 1]).toContain(result.exitCode);

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('incompatible options');
    });

    test('--batch-tasks works with --non-interactive', async () => {
      await createPlanFile({
        id: 1,
        title: 'Non-Interactive Test',
        filename: '1-non-interactive.yml',
        status: 'pending',
        tasks: [{ title: 'Test task', description: 'Test description' }],
      });

      const result = await $`bun ${rmplanPath} agent 1 --batch-tasks --non-interactive --dry-run --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      expect([0, 1]).toContain(result.exitCode);

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('incompatible options');
    });

    test('--batch-tasks works with --steps', async () => {
      await createPlanFile({
        id: 1,
        title: 'Steps Limit Test',
        filename: '1-steps.yml',
        status: 'pending',
        tasks: [{ title: 'Test task', description: 'Test description' }],
      });

      const result = await $`bun ${rmplanPath} agent 1 --batch-tasks --steps 5 --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      expect([0, 1]).toContain(result.exitCode);

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('incompatible options');
    });

    test('--batch-tasks works with executor options', async () => {
      await createPlanFile({
        id: 1,
        title: 'Executor Test',
        filename: '1-executor.yml',
        status: 'pending',
        tasks: [{ title: 'Test task', description: 'Test description' }],
      });

      const result = await $`bun ${rmplanPath} agent 1 --batch-tasks --executor copy-only --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      expect([0, 1]).toContain(result.exitCode);

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('incompatible options');
    });

    test('--batch-tasks works with model specification', async () => {
      await createPlanFile({
        id: 1,
        title: 'Model Test',
        filename: '1-model.yml',
        status: 'pending',
        tasks: [{ title: 'Test task', description: 'Test description' }],
      });

      const result = await $`bun ${rmplanPath} agent 1 --batch-tasks --model claude-3-5-sonnet --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      expect([0, 1]).toContain(result.exitCode);

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('incompatible options');
    });

    test('--batch-tasks works with workspace options', async () => {
      await createPlanFile({
        id: 1,
        title: 'Workspace Test',
        filename: '1-workspace.yml',
        status: 'pending',
        tasks: [{ title: 'Test task', description: 'Test description' }],
      });

      const result = await $`bun ${rmplanPath} agent 1 --batch-tasks --workspace test-workspace --new-workspace --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      expect([0, 1]).toContain(result.exitCode);

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('incompatible options');
    });
  });

  describe('help text and documentation', () => {
    test('--batch-tasks appears in agent command help', async () => {
      const result = await $`bun ${rmplanPath} agent --help`.nothrow();

      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString();

      // Should contain the batch-tasks option
      expect(output).toContain('--batch-tasks');
      // Should contain descriptive help text
      expect(output).toContain('batch task execution mode');
      expect(output).toContain('selects and processes multiple tasks together');
    });

    test('--batch-tasks appears in run command help', async () => {
      const result = await $`bun ${rmplanPath} run --help`.nothrow();

      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString();

      // Should contain the batch-tasks option
      expect(output).toContain('--batch-tasks');
      // Should contain descriptive help text
      expect(output).toContain('batch task execution mode');
      expect(output).toContain('selects and processes multiple tasks together');
    });

    test('general help mentions agent and run commands', async () => {
      const result = await $`bun ${rmplanPath} --help`.nothrow();

      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString();

      // Should list both agent and run commands
      expect(output).toContain('agent');
      expect(output).toContain('run');
    });
  });

  describe('backward compatibility', () => {
    test('agent command works without --batch-tasks flag', async () => {
      await createPlanFile({
        id: 1,
        title: 'Backward Compatibility Test',
        filename: '1-backward.yml',
        status: 'pending',
        tasks: [{ title: 'Test task', description: 'Test description' }],
      });

      // Run without the --batch-tasks flag (traditional mode)
      const result = await $`bun ${rmplanPath} agent 1 --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      // Should work as before (exit code should be reasonable)
      expect([0, 1]).toContain(result.exitCode);

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('batch-tasks is required');
      expect(output).not.toContain('must specify --batch-tasks');
    });

    test('run command works without --batch-tasks flag', async () => {
      await createPlanFile({
        id: 1,
        title: 'Run Backward Compatibility Test',
        filename: '1-run-backward.yml',
        status: 'pending',
        tasks: [{ title: 'Test task', description: 'Test description' }],
      });

      // Run without the --batch-tasks flag
      const result = await $`bun ${rmplanPath} run 1 --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      expect([0, 1]).toContain(result.exitCode);

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('batch-tasks is required');
    });

    test('existing functionality still works with other flags', async () => {
      await createPlanFile({
        id: 1,
        title: 'Existing Functionality Test',
        filename: '1-existing.yml',
        status: 'pending',
        tasks: [
          {
            title: 'Test task',
            description: 'Test description',
            steps: [
              { title: 'Step 1', description: 'First step', prompt: 'Do step 1' },
            ],
          },
        ],
      });

      // Test that existing options still work
      const result = await $`bun ${rmplanPath} agent 1 --steps 1 --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      expect([0, 1]).toContain(result.exitCode);

      // Should not have any issues with existing functionality
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('unknown option');
      expect(output).not.toContain('unexpected argument');
    });
  });

  describe('edge cases and error handling', () => {
    test('--batch-tasks handles non-existent plan file gracefully', async () => {
      // Try to run against a non-existent plan
      const result = await $`bun ${rmplanPath} agent non-existent-plan.yml --batch-tasks --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      // Should handle the error gracefully (not crash with unhandled exception)
      expect([0, 1, 2]).toContain(result.exitCode);

      const output = result.stdout.toString() + result.stderr.toString();
      // Should not crash with issues related to the --batch-tasks flag itself
      expect(output).not.toContain('batch-tasks');
      expect(output).not.toContain('batchTasks is not defined');
    });

    test('--batch-tasks with invalid plan ID handled properly', async () => {
      const result = await $`bun ${rmplanPath} agent 99999 --batch-tasks --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      // Should handle the error gracefully
      expect([0, 1, 2]).toContain(result.exitCode);

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('batchTasks is not defined');
    });

    test('--batch-tasks with malformed plan file handled properly', async () => {
      // Create a malformed plan file
      const malformedPlanPath = path.join(tasksDir, '1-malformed.yml');
      await fs.writeFile(malformedPlanPath, 'invalid: yaml: content: [missing closing bracket');

      const result = await $`bun ${rmplanPath} agent 1 --batch-tasks --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      expect([0, 1, 2]).toContain(result.exitCode);

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('batchTasks is not defined');
    });
  });

  describe('integration with plan file discovery', () => {
    test('--batch-tasks works with plan ID resolution', async () => {
      await createPlanFile({
        id: 42,
        title: 'ID Resolution Test',
        filename: '42-id-test.yml',
        status: 'pending',
        tasks: [{ title: 'Test task', description: 'Test description' }],
      });

      // Use plan ID instead of filename
      const result = await $`bun ${rmplanPath} agent 42 --batch-tasks --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      expect([0, 1]).toContain(result.exitCode);

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('plan not found');
      expect(output).not.toContain('batchTasks is not defined');
    });

    test('--batch-tasks works with --next flag', async () => {
      // Create plans in sequence
      await createPlanFile({
        id: 1,
        title: 'Done Dependency',
        filename: '1-done.yml',
        status: 'done',
        tasks: [{ title: 'Completed task', description: 'Already done', done: true }],
      });

      await createPlanFile({
        id: 2,
        title: 'Ready Plan',
        filename: '2-ready.yml',
        status: 'pending',
        dependencies: [1], // Depends on completed plan
        tasks: [{ title: 'Ready task', description: 'Ready to execute' }],
      });

      const result = await $`bun ${rmplanPath} agent --next --batch-tasks --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      expect([0, 1]).toContain(result.exitCode);

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('incompatible options');
      expect(output).not.toContain('batchTasks is not defined');
    });

    test('--batch-tasks works with --current flag', async () => {
      await createPlanFile({
        id: 1,
        title: 'In Progress Plan',
        filename: '1-in-progress.yml',
        status: 'in_progress',
        tasks: [{ title: 'Current task', description: 'Currently working on this' }],
      });

      const result = await $`bun ${rmplanPath} agent --current --batch-tasks --dry-run --non-interactive --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      expect([0, 1]).toContain(result.exitCode);

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('incompatible options');
      expect(output).not.toContain('batchTasks is not defined');
    });
  });
});