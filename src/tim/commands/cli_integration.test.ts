import { vi, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import type { PlanSchema } from '../planSchema.js';
import { readPlanFile } from '../plans.js';
import { handleAddCommand } from './add.js';
import { handleSetCommand } from './set.js';
import { handleValidateCommand } from './validate.js';
import { ModuleMocker } from '../../testing.js';

/**
 * Integration tests for parent-child relationship functionality in tim commands.
 *
 * These tests verify the complete workflow of creating, modifying, and validating
 * parent-child relationships across the add, set, and validate commands, ensuring
 * that bidirectional relationships are maintained automatically.
 */
describe.skip('CLI integration tests for parent-child relationships (internal handlers)', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;
  let commandObj: any;
  const moduleMocker = new ModuleMocker(import.meta);

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Create temporary directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-cli-integration-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Create some dummy source files for rmfilter to work with
    const srcDir = path.join(tempDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'index.ts'), '// Test file\nconst test = "hello";');
    await fs.writeFile(path.join(srcDir, 'utils.ts'), '// Utils file\nexport const utils = {};');

    // Create config file that points to tasks directory
    configPath = path.join(tempDir, '.rmfilter', 'tim.yml');
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

    // Command object to pass config to handlers
    commandObj = { parent: { opts: () => ({ config: configPath }) } } as any;

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));
  });

  afterEach(async () => {
    // Clean up the temporary directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    moduleMocker.clear();
  });

  async function createPlanFile(plan: PlanSchema & { filename: string }) {
    const filePath = path.join(tasksDir, plan.filename);

    // Create a proper plan object according to the schema
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';
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

  describe('parent-child relationship validation integration tests', () => {
    test('parent-child workflow with add and validate', async () => {
      // Create plans using add command
      await handleAddCommand(['Parent', 'Plan'], { priority: 'high' }, commandObj);
      await handleAddCommand(['Child', 'Plan'], {}, commandObj);

      // Find child plan file path and set its parent
      const childFile = (await fs.readdir(tasksDir)).find((f) =>
        f.endsWith('-child-plan.plan.md')
      )!;
      await handleSetCommand(
        path.join(tasksDir, childFile),
        { parent: 1 },
        commandObj.parent.opts()
      );

      // Verify that the plans were created correctly by checking file contents
      const parentPlan = await readPlanFile(path.join(tasksDir, '1-parent-plan.plan.md'));
      expect(parentPlan.id).toBe(1);
      expect(parentPlan.title).toBe('Parent Plan');
      expect(parentPlan.dependencies).toContain(2);

      const childPlan = await readPlanFile(path.join(tasksDir, '2-child-plan.plan.md'));
      expect(childPlan.id).toBe(2);
      expect(childPlan.title).toBe('Child Plan');
      expect(childPlan.parent).toBe(1);

      // Run validate command to ensure no inconsistencies are found
      await handleValidateCommand({}, commandObj);
      const output = (console.log as any).mock.calls.flat().map(String).join('\n');
      expect(output).toContain('Validating 2 plan files');
      expect(output).toContain('Checking parent-child relationships');
      expect(output).toContain('2 valid');
      expect(output).not.toContain('parent-child inconsistencies');
      expect(output).not.toContain('parent-child relationships fixed');
    });

    test('parent-child workflow with set and validate', async () => {
      // Create two independent plans
      await handleAddCommand(['Plan', 'One'], {}, commandObj);
      await handleAddCommand(['Plan', 'Two'], {}, commandObj);

      // Use set command to establish parent-child relationship
      await handleSetCommand('2', { parent: 1 }, commandObj.parent.opts());

      // Verify the relationship was established by checking file contents
      const parentPlan = await readPlanFile(path.join(tasksDir, '1-plan-one.plan.md'));
      expect(parentPlan.dependencies).toContain(2);

      const childPlan = await readPlanFile(path.join(tasksDir, '2-plan-two.plan.md'));
      expect(childPlan.parent).toBe(1);

      // Run validate to ensure no inconsistencies
      await handleValidateCommand({}, commandObj);
      const output1 = (console.log as any).mock.calls.flat().map(String).join('\n');
      expect(output1).toContain('2 valid');
      expect(output1).not.toContain('parent-child inconsistencies');

      // Ensure the relationship exists
      expect(childPlan.parent).toBe(1);
      expect(parentPlan.dependencies).toContain(2);
    });

    test('complex hierarchy validation', async () => {
      // Create a multi-level hierarchy: grandparent -> parent -> child
      await handleAddCommand(['Grandparent', 'Plan'], {}, commandObj);
      await handleAddCommand(['Parent', 'Plan'], {}, commandObj);
      await handleAddCommand(['Child', 'Plan'], {}, commandObj);

      // Establish relationships via set command using filenames
      const files = await fs.readdir(tasksDir);
      const parentFile = files.find((f) => f.endsWith('-parent-plan.plan.md'))!;
      const childFile = files.find((f) => f.endsWith('-child-plan.plan.md'))!;
      await handleSetCommand(
        path.join(tasksDir, parentFile),
        { parent: 1 },
        commandObj.parent.opts()
      );
      await handleSetCommand(
        path.join(tasksDir, childFile),
        { parent: 2 },
        commandObj.parent.opts()
      );

      // Validate the initial hierarchy
      (console.log as any).mockClear();
      await handleValidateCommand({}, commandObj);
      expect((console.log as any).mock.calls.flat().map(String).join('\n')).toContain('3 valid');

      // Verify initial structure by reading files
      let grandparentPlan = await readPlanFile(path.join(tasksDir, '1-grandparent-plan.plan.md'));
      let parentPlan = await readPlanFile(path.join(tasksDir, '2-parent-plan.plan.md'));
      let childPlan = await readPlanFile(path.join(tasksDir, '3-child-plan.plan.md'));

      expect(grandparentPlan.dependencies).toContain(2);
      expect(parentPlan.parent).toBe(1);
      expect(parentPlan.dependencies).toContain(3);
      expect(childPlan.parent).toBe(2);

      // Modify relationships using set command - change child's parent from 2 to 1
      await handleSetCommand('3', { parent: 1 }, commandObj.parent.opts());

      // Verify the parent change took effect
      grandparentPlan = await readPlanFile(path.join(tasksDir, '1-grandparent-plan.plan.md'));
      parentPlan = await readPlanFile(path.join(tasksDir, '2-parent-plan.plan.md'));
      childPlan = await readPlanFile(path.join(tasksDir, '3-child-plan.plan.md'));

      expect(grandparentPlan.dependencies).toContain(3); // Now includes child directly
      expect(parentPlan.dependencies || []).not.toContain(3); // Child removed from old parent
      expect(childPlan.parent).toBe(1); // Child's parent changed to grandparent

      // Validate the structure remains consistent after the change
      (console.log as any).mockClear();
      await handleValidateCommand({}, commandObj);
      const out2 = (console.log as any).mock.calls.flat().map(String).join('\n');
      expect(out2).toContain('3 valid');
      expect(out2).not.toContain('parent-child inconsistencies');

      // Add another child to create multiple children for one parent
      await handleAddCommand(['Second', 'Child'], { parent: 1 }, commandObj);

      // Verify the new structure
      grandparentPlan = await readPlanFile(path.join(tasksDir, '1-grandparent-plan.plan.md'));
      const secondChildPlan = await readPlanFile(path.join(tasksDir, '4-second-child.plan.md'));

      expect(grandparentPlan.dependencies).toContain(4); // Includes second child
      expect(secondChildPlan.parent).toBe(1); // Second child's parent is grandparent

      // Final validation to ensure the complex structure is consistent
      (console.log as any).mockClear();
      await handleValidateCommand({}, commandObj);
      const out3 = (console.log as any).mock.calls.flat().map(String).join('\n');
      expect(out3).toContain('4 valid');
      expect(out3).not.toContain('parent-child inconsistencies');
    });

    test('validate auto-fix integration', async () => {
      // Create parent and child plans manually to create an inconsistent state
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [], // Missing child dependency - this creates inconsistency
        tasks: [{ title: 'Parent task', description: 'Do parent work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Child Plan',
        filename: '2-child.yml',
        status: 'pending',
        parent: 1, // Has parent but parent doesn't have this in dependencies
        tasks: [{ title: 'Child task', description: 'Do child work' }],
      });

      // Run validate command which should auto-fix the inconsistency
      await handleValidateCommand({}, commandObj);
      const output = (console.log as any).mock.calls.flat().map(String).join('\n');

      // Should report finding inconsistencies and fixing them
      expect(output).toContain('Validating 2 plan files');
      expect(output).toContain('Found 1 parent-child inconsistencies');
      expect(output).toContain('Parent plan 1 missing dependencies for child 2');
      expect(output).toContain('Auto-fixing parent-child relationships');
      expect(output).toContain('Updated plan 1 to include child 2 in dependencies');
      expect(output).toContain('1 parent-child relationships fixed');
      expect(output).toContain('2 valid');

      // Verify that the parent plan was actually updated by reading the file
      const parentPlan = await readPlanFile(path.join(tasksDir, '1-parent.yml'));
      expect(parentPlan.dependencies).toContain(2);

      // Run validate again to ensure there are no more inconsistencies
      (console.log as any).mockClear();
      await handleValidateCommand({}, commandObj);
      const output2 = (console.log as any).mock.calls.flat().map(String).join('\n');
      expect(output2).toContain('2 valid');
      expect(output2).not.toContain('parent-child inconsistencies');
      expect(output2).not.toContain('parent-child relationships fixed');
    });
  });
});
