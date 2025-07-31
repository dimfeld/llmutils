import { $ } from 'bun';
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import type { PlanSchema } from '../planSchema.js';

describe('CLI integration tests for --next-ready flag', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;
  let rmplanPath: string;

  beforeEach(async () => {
    // Create temporary directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-cli-integration-'));
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

  describe('generate command with --next-ready', () => {
    test('should find and generate for next ready dependency', async () => {
      // Create test plans hierarchy: parent -> done dependency -> ready dependency
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2, 3],
        tasks: [{ title: 'Parent task', description: 'Do parent work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Done Dependency',
        filename: '2-done.yml',
        status: 'done',
        tasks: [{ title: 'Done task', description: 'Already completed', done: true }],
      });

      await createPlanFile({
        id: 3,
        title: 'Ready Dependency',
        filename: '3-ready.yml',
        status: 'pending',
        dependencies: [2], // Depends on plan 2 which is done
        priority: 'high',
        tasks: [{ title: 'Ready task', description: 'Ready to work on' }],
      });

      // Execute generate command with --next-ready
      const result =
        await $`bun ${rmplanPath} generate --next-ready 1 --no-extract --config ${configPath}`
          .cwd(tempDir)
          .nothrow();

      // Should succeed
      expect(result.exitCode).toBe(0);

      // Should mention finding the ready dependency
      const output = result.stdout.toString();
      expect(output).toContain('Found ready dependency');
      expect(output).toContain('Ready Dependency');
    });

    test('should handle multiple ready dependencies with priority ordering', async () => {
      // Create test plans with multiple ready dependencies at different priorities
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2, 3, 4],
        tasks: [{ title: 'Parent task', description: 'Do parent work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Low Priority Dependency',
        filename: '2-low.yml',
        status: 'pending',
        priority: 'low',
        tasks: [{ title: 'Low priority task', description: 'Lower priority work' }],
      });

      await createPlanFile({
        id: 3,
        title: 'High Priority Dependency',
        filename: '3-high.yml',
        status: 'pending',
        priority: 'high',
        tasks: [{ title: 'High priority task', description: 'Higher priority work' }],
      });

      await createPlanFile({
        id: 4,
        title: 'Urgent Priority Dependency',
        filename: '4-urgent.yml',
        status: 'pending',
        priority: 'urgent',
        tasks: [{ title: 'Urgent task', description: 'Most urgent work' }],
      });

      // Execute generate command with --next-ready
      const result =
        await $`bun ${rmplanPath} generate --next-ready 1 --no-extract --config ${configPath}`
          .cwd(tempDir)
          .nothrow();

      // Should succeed and find the urgent priority dependency
      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString();
      expect(output).toContain('Found ready dependency');
      expect(output).toContain('Urgent Priority Dependency');
    });

    test('should handle no ready dependencies gracefully', async () => {
      // Create parent plan with dependencies that aren't ready
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2],
        tasks: [{ title: 'Parent task', description: 'Do parent work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Blocked Dependency',
        filename: '2-blocked.yml',
        status: 'pending',
        dependencies: [3], // Depends on plan 3
        tasks: [{ title: 'Blocked task', description: 'Cannot start yet' }],
      });

      await createPlanFile({
        id: 3,
        title: 'In Progress Dependency',
        filename: '3-in-progress.yml',
        status: 'in_progress',
        tasks: [{ title: 'In progress task', description: 'Still working' }],
      });

      // Execute generate command with --next-ready
      const result =
        await $`bun ${rmplanPath} generate --next-ready 1 --no-extract --config ${configPath}`
          .cwd(tempDir)
          .nothrow();

      // Should succeed (finds the in_progress plan)
      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString();
      expect(output).toContain('Found in-progress plan');
      expect(output).toContain('In Progress Dependency');
    });

    test('should handle non-existent parent plan gracefully', async () => {
      // Execute generate command with non-existent parent plan
      const result =
        await $`bun ${rmplanPath} generate --next-ready 999 --no-extract --config ${configPath}`
          .cwd(tempDir)
          .nothrow();

      // Should succeed but output the error message (generate command logs error but continues)
      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).toContain('Plan not found: 999');
    });

    test('should work with --direct flag combination', async () => {
      // Create simple plan hierarchy
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2],
        tasks: [{ title: 'Parent task', description: 'Do parent work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Ready Dependency',
        filename: '2-ready.yml',
        status: 'pending',
        tasks: [{ title: 'Ready task', description: 'Ready to work on' }],
      });

      // Execute generate command with --next-ready and --direct
      const result =
        await $`bun ${rmplanPath} generate --next-ready 1 --direct --no-extract --config ${configPath}`
          .cwd(tempDir)
          .nothrow();

      // Should succeed and indicate direct mode
      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString();
      expect(output).toContain('Found ready dependency');
      expect(output).toContain('Ready Dependency');
    });
  });

  describe('prepare command with --next-ready', () => {
    test('should find ready dependency in output (even if fails later)', async () => {
      // Create test plans
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2],
        tasks: [{ title: 'Parent task', description: 'Do parent work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Ready Dependency',
        filename: '2-ready.yml',
        status: 'pending',
        tasks: [{ title: 'Ready task', description: 'Ready to prepare' }],
      });

      // Execute prepare command with --next-ready (will fail due to rmfilter, but should show dependency discovery)
      const result = await $`bun ${rmplanPath} prepare --next-ready 1 --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      // The command will fail, but should show that it found the dependency
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).toContain('Found ready dependency');
      expect(output).toContain('Ready Dependency');
    });

    test('should show no dependencies found message', async () => {
      // Create parent plan with no dependencies
      await createPlanFile({
        id: 1,
        title: 'Standalone Plan',
        filename: '1-standalone.yml',
        status: 'pending',
        tasks: [{ title: 'Standalone task', description: 'No dependencies' }],
      });

      // Execute prepare command with --next-ready
      const result = await $`bun ${rmplanPath} prepare --next-ready 1 --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      // Should output the error message
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).toContain('No ready dependencies found');
      expect(output).toContain('No dependencies found for this plan');
    });
  });

  describe('agent command with --next-ready', () => {
    test('should find ready dependency in output (even if fails later)', async () => {
      // Create test plans
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2],
        tasks: [{ title: 'Parent task', description: 'Do parent work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Ready Dependency',
        filename: '2-ready.yml',
        status: 'pending',
        tasks: [{ title: 'Ready task', description: 'Ready to execute' }],
      });

      // Execute agent command with --next-ready and --dry-run
      const result =
        await $`bun ${rmplanPath} agent --next-ready 1 --dry-run --non-interactive --config ${configPath}`
          .cwd(tempDir)
          .nothrow();

      // The command may fail, but should show that it found the dependency
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).toContain('Found ready dependency');
      expect(output).toContain('Ready Dependency');
    });

    test('should show no dependencies found message', async () => {
      // Create parent plan with no dependencies
      await createPlanFile({
        id: 1,
        title: 'Standalone Plan',
        filename: '1-standalone.yml',
        status: 'pending',
        tasks: [{ title: 'Standalone task', description: 'No dependencies' }],
      });

      // Execute agent command with --next-ready
      const result =
        await $`bun ${rmplanPath} agent --next-ready 1 --dry-run --non-interactive --config ${configPath}`
          .cwd(tempDir)
          .nothrow();

      // Should output the error message
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).toContain('No ready dependencies found');
      expect(output).toContain('No dependencies found for this plan');
    });
  });

  describe('edge cases and error conditions', () => {
    test('should handle non-existent parent plans', async () => {
      // Test all three commands with non-existent parent
      const commands = [
        ['generate', '--no-extract'],
        ['prepare', '--', 'src/**/*.ts'],
        ['agent', '--dry-run', '--non-interactive'],
      ];

      for (const [command, ...extraArgs] of commands) {
        const result =
          await $`bun ${rmplanPath} ${command} --next-ready 999 ${extraArgs} --config ${configPath}`
            .cwd(tempDir)
            .nothrow();

        // Commands may succeed but log the error message
        const output = result.stdout.toString() + result.stderr.toString();
        expect(output).toContain('Plan not found: 999');
      }
    });

    test('should handle plans with no dependencies at all', async () => {
      // Create standalone plan
      await createPlanFile({
        id: 1,
        title: 'Standalone Plan',
        filename: '1-standalone.yml',
        status: 'pending',
        tasks: [{ title: 'Standalone task', description: 'No dependencies' }],
      });

      // Test generate command
      const generateResult =
        await $`bun ${rmplanPath} generate --next-ready 1 --no-extract --config ${configPath}`
          .cwd(tempDir)
          .nothrow();
      const generateOutput = generateResult.stdout.toString() + generateResult.stderr.toString();
      expect(generateOutput).toContain('No ready dependencies found');
      expect(generateOutput).toContain('No dependencies found for this plan');

      // Test prepare command
      const prepareResult = await $`bun ${rmplanPath} prepare --next-ready 1 --config ${configPath}`
        .cwd(tempDir)
        .nothrow();
      const prepareOutput = prepareResult.stdout.toString() + prepareResult.stderr.toString();
      expect(prepareOutput).toContain('No ready dependencies found');
      expect(prepareOutput).toContain('No dependencies found for this plan');

      // Test agent command
      const agentResult =
        await $`bun ${rmplanPath} agent --next-ready 1 --dry-run --non-interactive --config ${configPath}`
          .cwd(tempDir)
          .nothrow();
      const agentOutput = agentResult.stdout.toString() + agentResult.stderr.toString();
      expect(agentOutput).toContain('No ready dependencies found');
      expect(agentOutput).toContain('No dependencies found for this plan');
    });

    test('should handle plans where all dependencies are completed', async () => {
      // Create plan with all dependencies done
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2, 3],
        tasks: [{ title: 'Parent task', description: 'Do parent work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Done Dependency 1',
        filename: '2-done1.yml',
        status: 'done',
        tasks: [{ title: 'Done task 1', description: 'Completed', done: true }],
      });

      await createPlanFile({
        id: 3,
        title: 'Done Dependency 2',
        filename: '3-done2.yml',
        status: 'done',
        tasks: [{ title: 'Done task 2', description: 'Completed', done: true }],
      });

      // Test generate command
      const generateResult =
        await $`bun ${rmplanPath} generate --next-ready 1 --no-extract --config ${configPath}`
          .cwd(tempDir)
          .nothrow();
      const generateOutput = generateResult.stdout.toString() + generateResult.stderr.toString();
      expect(generateOutput).toContain('No ready dependencies found');
      expect(generateOutput).toContain('All dependencies are complete');

      // Test prepare command
      const prepareResult = await $`bun ${rmplanPath} prepare --next-ready 1 --config ${configPath}`
        .cwd(tempDir)
        .nothrow();
      const prepareOutput = prepareResult.stdout.toString() + prepareResult.stderr.toString();
      expect(prepareOutput).toContain('No ready dependencies found');
      expect(prepareOutput).toContain('All dependencies are complete');

      // Test agent command
      const agentResult =
        await $`bun ${rmplanPath} agent --next-ready 1 --dry-run --non-interactive --config ${configPath}`
          .cwd(tempDir)
          .nothrow();
      const agentOutput = agentResult.stdout.toString() + agentResult.stderr.toString();
      expect(agentOutput).toContain('No ready dependencies found');
      expect(agentOutput).toContain('All dependencies are complete');
    });

    test('should handle circular dependencies gracefully', async () => {
      // Create circular dependency
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2, 3],
        tasks: [{ title: 'Parent task', description: 'Do parent work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Child A',
        filename: '2-child-a.yml',
        status: 'pending',
        dependencies: [3], // Depends on sibling
        tasks: [{ title: 'Child A task', description: 'Depends on Child B' }],
      });

      await createPlanFile({
        id: 3,
        title: 'Child B',
        filename: '3-child-b.yml',
        status: 'pending',
        dependencies: [2], // Depends back on Child A - creating a cycle
        tasks: [{ title: 'Child B task', description: 'Depends on Child A' }],
      });

      // Test generate command
      const generateResult =
        await $`bun ${rmplanPath} generate --next-ready 1 --no-extract --config ${configPath}`
          .cwd(tempDir)
          .nothrow();
      const generateOutput = generateResult.stdout.toString() + generateResult.stderr.toString();
      expect(generateOutput).toContain('No ready dependencies found');
      expect(generateOutput).toContain('dependencies are blocked by incomplete prerequisites');

      // Test prepare command
      const prepareResult = await $`bun ${rmplanPath} prepare --next-ready 1 --config ${configPath}`
        .cwd(tempDir)
        .nothrow();
      const prepareOutput = prepareResult.stdout.toString() + prepareResult.stderr.toString();
      expect(prepareOutput).toContain('No ready dependencies found');
      expect(prepareOutput).toContain('dependencies are blocked by incomplete prerequisites');

      // Test agent command
      const agentResult =
        await $`bun ${rmplanPath} agent --next-ready 1 --dry-run --non-interactive --config ${configPath}`
          .cwd(tempDir)
          .nothrow();
      const agentOutput = agentResult.stdout.toString() + agentResult.stderr.toString();
      expect(agentOutput).toContain('No ready dependencies found');
      expect(agentOutput).toContain('dependencies are blocked by incomplete prerequisites');
    });
  });

  describe('option composition tests', () => {
    test('generate command --next-ready works with --direct option', async () => {
      // Create simple hierarchy
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2],
        tasks: [{ title: 'Parent task', description: 'Do parent work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Ready Dependency',
        filename: '2-ready.yml',
        status: 'pending',
        tasks: [{ title: 'Ready task', description: 'Ready to work on' }],
      });

      // Test --next-ready with --direct
      const result =
        await $`bun ${rmplanPath} generate --next-ready 1 --direct --no-extract --config ${configPath}`
          .cwd(tempDir)
          .nothrow();

      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString();
      expect(output).toContain('Found ready dependency');
      expect(output).toContain('Ready Dependency');
    });

    test('prepare command --next-ready works (shows dependency discovery)', async () => {
      // Create simple hierarchy
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2],
        tasks: [{ title: 'Parent task', description: 'Do parent work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Ready Dependency',
        filename: '2-ready.yml',
        status: 'pending',
        tasks: [{ title: 'Ready task', description: 'Ready to prepare' }],
      });

      // Test --next-ready (will show dependency discovery even if command fails later)
      const result = await $`bun ${rmplanPath} prepare --next-ready 1 --config ${configPath}`
        .cwd(tempDir)
        .nothrow();

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).toContain('Found ready dependency');
      expect(output).toContain('Ready Dependency');
    });

    test('agent command --next-ready works with --dry-run option', async () => {
      // Create simple hierarchy
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2],
        tasks: [{ title: 'Parent task', description: 'Do parent work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Ready Dependency',
        filename: '2-ready.yml',
        status: 'pending',
        tasks: [{ title: 'Ready task', description: 'Ready to execute' }],
      });

      // Test --next-ready with --dry-run
      const result =
        await $`bun ${rmplanPath} agent --next-ready 1 --dry-run --non-interactive --config ${configPath}`
          .cwd(tempDir)
          .nothrow();

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).toContain('Found ready dependency');
      expect(output).toContain('Ready Dependency');
    });

    test('agent command --next-ready works with multiple options', async () => {
      // Create simple hierarchy
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2],
        tasks: [{ title: 'Parent task', description: 'Do parent work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Ready Dependency',
        filename: '2-ready.yml',
        status: 'pending',
        tasks: [{ title: 'Ready task', description: 'Ready to execute' }],
      });

      // Test --next-ready with multiple options
      const result =
        await $`bun ${rmplanPath} agent --next-ready 1 --dry-run --direct --steps 1 --non-interactive --config ${configPath}`
          .cwd(tempDir)
          .nothrow();

      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).toContain('Found ready dependency');
      expect(output).toContain('Ready Dependency');
    });
  });
});
