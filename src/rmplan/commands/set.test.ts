import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'yaml';
import { readPlanFile } from '../plans.js';
import { handleSetCommand } from './set.js';
import type { PlanSchema } from '../planSchema.js';
import { setDebug } from '../../common/process.js';
import type { RmplanConfig } from '../configSchema.js';

describe('rmplan set command', () => {
  let tempDir: string;
  let tasksDir: string;
  let globalOpts: any;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'rmplan-set-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    let config: RmplanConfig = {
      paths: {
        tasks: tasksDir,
      },
    };
    await mkdir(tasksDir, { recursive: true });
    await Bun.file(path.join(tempDir, '.rmplan.yml')).write(yaml.stringify(config));
    globalOpts = {
      config: path.join(tempDir, '.rmplan.yml'),
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  const createTestPlan = async (id: number) => {
    const planPath = path.join(tasksDir, `${id}.yml`);
    const plan: PlanSchema = {
      id,
      goal: `Test plan ${id}`,
      details: `Details for test plan ${id}`,
      priority: 'medium',
      status: 'pending',
      tasks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const yamlContent = yaml.stringify(plan);
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';
    await writeFile(planPath, schemaLine + yamlContent);
    return planPath;
  };

  test('should update priority', async () => {
    const planPath = await createTestPlan(10);

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        priority: 'high',
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.priority).toBe('high');
    expect(updatedPlan.updatedAt).toBeDefined();
  });

  test('should update status', async () => {
    const planPath = await createTestPlan(11);

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        status: 'in_progress',
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.status).toBe('in_progress');
  });

  test('should add dependencies', async () => {
    const planPath = await createTestPlan(12);

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        dependsOn: [10, 11],
      },
      {}
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.dependencies).toEqual([10, 11]);
  });

  test('should not duplicate dependencies', async () => {
    const planPath = await createTestPlan(13);

    // First add
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        dependsOn: [10],
      },
      globalOpts
    );

    // Try to add again with overlap
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        dependsOn: [10, 11],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.dependencies).toEqual([10, 11]);
  });

  test('should remove dependencies', async () => {
    const planPath = await createTestPlan(14);

    // First add dependencies
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        dependsOn: [10, 11, 12],
      },
      globalOpts
    );

    // Remove some
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        noDependsOn: [10, 12],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.dependencies).toEqual([11]);
  });

  test('should update rmfilter', async () => {
    const planPath = await createTestPlan(15);

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        rmfilter: ['src/**/*.ts', 'tests/**/*.test.ts'],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.rmfilter).toEqual(['src/**/*.ts', 'tests/**/*.test.ts']);
  });

  test('should update multiple fields at once', async () => {
    const planPath = await createTestPlan(16);

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        priority: 'urgent',
        status: 'in_progress',
        dependsOn: [10, 11],
        rmfilter: ['src/**/*.ts'],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.priority).toBe('urgent');
    expect(updatedPlan.status).toBe('in_progress');
    expect(updatedPlan.dependencies).toEqual([10, 11]);
    expect(updatedPlan.rmfilter).toEqual(['src/**/*.ts']);
  });

  test('should not update if no changes made', async () => {
    const planPath = await createTestPlan(17);
    const originalPlan = await readPlanFile(planPath);
    const originalUpdatedAt = originalPlan.updatedAt;

    // Wait a bit to ensure time difference
    await new Promise((resolve) => setTimeout(resolve, 10));

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
      },
      globalOpts
    );

    const unchangedPlan = await readPlanFile(planPath);
    expect(unchangedPlan.updatedAt).toBe(originalUpdatedAt);
  });

  test('should add issue URLs', async () => {
    const planPath = await createTestPlan(18);

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        issue: [
          'https://github.com/owner/repo/issues/123',
          'https://github.com/owner/repo/issues/124',
        ],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.issue).toEqual([
      'https://github.com/owner/repo/issues/123',
      'https://github.com/owner/repo/issues/124',
    ]);
  });

  test('should not duplicate issue URLs', async () => {
    const planPath = await createTestPlan(19);

    // First add
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        issue: ['https://github.com/owner/repo/issues/123'],
      },
      globalOpts
    );

    // Try to add again with overlap
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        issue: [
          'https://github.com/owner/repo/issues/123',
          'https://github.com/owner/repo/issues/124',
        ],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.issue).toEqual([
      'https://github.com/owner/repo/issues/123',
      'https://github.com/owner/repo/issues/124',
    ]);
  });

  test('should remove issue URLs', async () => {
    const planPath = await createTestPlan(20);

    // First add issue URLs
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        issue: [
          'https://github.com/owner/repo/issues/123',
          'https://github.com/owner/repo/issues/124',
          'https://github.com/owner/repo/issues/125',
        ],
      },
      globalOpts
    );

    // Remove some
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        noIssue: [
          'https://github.com/owner/repo/issues/123',
          'https://github.com/owner/repo/issues/125',
        ],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.issue).toEqual(['https://github.com/owner/repo/issues/124']);
  });

  test('should handle plans without existing dependencies', async () => {
    const planPath = await createTestPlan(21);

    // Remove dependencies
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        noDependsOn: [10, 11],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.dependencies).toBeUndefined();
  });

  test('should handle plans without existing issue URLs', async () => {
    const planPath = await createTestPlan(22);

    // Remove issue URLs
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        noIssue: ['https://github.com/owner/repo/issues/123'],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.issue).toBeUndefined();
  });

  test('should add documentation paths', async () => {
    const planPath = await createTestPlan('23');

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        doc: ['docs/setup.md', 'docs/api.md'],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.docs).toEqual(['docs/setup.md', 'docs/api.md']);
  });

  test('should not duplicate documentation paths', async () => {
    const planPath = await createTestPlan('24');

    // First add
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        doc: ['docs/setup.md'],
      },
      globalOpts
    );

    // Try to add again with overlap
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        doc: ['docs/setup.md', 'docs/api.md'],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.docs).toEqual(['docs/setup.md', 'docs/api.md']);
  });

  test('should remove documentation paths', async () => {
    const planPath = await createTestPlan('25');

    // First add documentation paths
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        doc: ['docs/setup.md', 'docs/api.md', 'docs/guide.md'],
      },
      globalOpts
    );

    // Remove some
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        noDoc: ['docs/setup.md', 'docs/guide.md'],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.docs).toEqual(['docs/api.md']);
  });

  test('should handle plans without existing documentation paths', async () => {
    const planPath = await createTestPlan('26');

    // Remove documentation paths from plan without any
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        noDoc: ['docs/setup.md'],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.docs).toBeUndefined();
  });

  test('should handle adding and removing documentation paths in same command', async () => {
    const planPath = await createTestPlan('27');

    // First add some docs
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        doc: ['docs/old1.md', 'docs/old2.md', 'docs/keep.md'],
      },
      globalOpts
    );

    // Add new and remove old in same command
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        doc: ['docs/new1.md', 'docs/new2.md'],
        noDoc: ['docs/old1.md', 'docs/old2.md'],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.docs).toEqual(['docs/keep.md', 'docs/new1.md', 'docs/new2.md']);
  });

  test('should set parent plan', async () => {
    // Create both parent and child plans
    const parentPlanPath = await createTestPlan(15);
    const planPath = await createTestPlan(30);

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        parent: 15,
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.parent).toBe(15);
  });

  test('should remove parent plan', async () => {
    // Create both parent and child plans
    const parentPlanPath = await createTestPlan(20);
    const planPath = await createTestPlan(31);

    // First set a parent
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        parent: 20,
      },
      globalOpts
    );

    let updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.parent).toBe(20);

    // Then remove it
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        noParent: true,
      },
      globalOpts
    );

    updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.parent).toBeUndefined();
  });

  test('should handle removing parent when none exists', async () => {
    const planPath = await createTestPlan(32);

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        noParent: true,
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.parent).toBeUndefined();
  });

  test('should throw error when setting non-existent parent', async () => {
    const planPath = await createTestPlan(33);

    await expect(
      handleSetCommand(
        planPath,
        {
          planFile: planPath,
          parent: 999, // Non-existent parent ID
        },
        globalOpts
      )
    ).rejects.toThrow('Parent plan with ID 999 not found');
  });

  test('should allow setting existing parent', async () => {
    // Create a parent plan first
    const parentPlanPath = await createTestPlan(100);
    const childPlanPath = await createTestPlan(101);

    // Set parent to the existing plan
    await handleSetCommand(
      childPlanPath,
      {
        planFile: childPlanPath,
        parent: 100,
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(childPlanPath);
    expect(updatedPlan.parent).toBe(100);
  });
});
