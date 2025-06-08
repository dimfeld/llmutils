import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'yaml';
import { readPlanFile } from '../plans.js';
import { handleSetCommand } from './set.js';
import type { PlanSchema } from '../planSchema.js';

describe('rmplan set command', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'rmplan-set-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  const createTestPlan = async (id: string) => {
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
    const planPath = await createTestPlan('10');

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        priority: 'high',
      },
      {}
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.priority).toBe('high');
    expect(updatedPlan.updatedAt).toBeDefined();
  });

  test('should update status', async () => {
    const planPath = await createTestPlan('11');

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        status: 'in_progress',
      },
      {}
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.status).toBe('in_progress');
  });

  test('should add dependencies', async () => {
    const planPath = await createTestPlan('12');

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        dependsOn: ['10', '11'],
      },
      {}
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.dependencies).toEqual([10, 11]);
  });

  test('should not duplicate dependencies', async () => {
    const planPath = await createTestPlan('13');

    // First add
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        dependsOn: ['10'],
      },
      {}
    );

    // Try to add again with overlap
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        dependsOn: ['10', '11'],
      },
      {}
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.dependencies).toEqual([10, 11]);
  });

  test('should remove dependencies', async () => {
    const planPath = await createTestPlan('14');

    // First add dependencies
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        dependsOn: ['10', '11', '12'],
      },
      {}
    );

    // Remove some
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        noDependsOn: ['10', '12'],
      },
      {}
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.dependencies).toEqual([11]);
  });

  test('should update rmfilter', async () => {
    const planPath = await createTestPlan('15');

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        rmfilter: ['src/**/*.ts', 'tests/**/*.test.ts'],
      },
      {}
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.rmfilter).toEqual(['src/**/*.ts', 'tests/**/*.test.ts']);
  });

  test('should update multiple fields at once', async () => {
    const planPath = await createTestPlan('16');

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        priority: 'urgent',
        status: 'in_progress',
        dependsOn: ['10', '11'],
        rmfilter: ['src/**/*.ts'],
      },
      {}
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.priority).toBe('urgent');
    expect(updatedPlan.status).toBe('in_progress');
    expect(updatedPlan.dependencies).toEqual([10, 11]);
    expect(updatedPlan.rmfilter).toEqual(['src/**/*.ts']);
  });

  test('should not update if no changes made', async () => {
    const planPath = await createTestPlan('17');
    const originalPlan = await readPlanFile(planPath);
    const originalUpdatedAt = originalPlan.updatedAt;

    // Wait a bit to ensure time difference
    await new Promise((resolve) => setTimeout(resolve, 10));

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
      },
      {}
    );

    const unchangedPlan = await readPlanFile(planPath);
    expect(unchangedPlan.updatedAt).toBe(originalUpdatedAt);
  });

  test('should add issue URLs', async () => {
    const planPath = await createTestPlan('18');

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        issue: [
          'https://github.com/owner/repo/issues/123',
          'https://github.com/owner/repo/issues/124',
        ],
      },
      {}
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.issue).toEqual([
      'https://github.com/owner/repo/issues/123',
      'https://github.com/owner/repo/issues/124',
    ]);
  });

  test('should not duplicate issue URLs', async () => {
    const planPath = await createTestPlan('19');

    // First add
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        issue: ['https://github.com/owner/repo/issues/123'],
      },
      {}
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
      {}
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.issue).toEqual([
      'https://github.com/owner/repo/issues/123',
      'https://github.com/owner/repo/issues/124',
    ]);
  });

  test('should remove issue URLs', async () => {
    const planPath = await createTestPlan('20');

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
      {}
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
      {}
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.issue).toEqual(['https://github.com/owner/repo/issues/124']);
  });

  test('should handle plans without existing dependencies', async () => {
    const planPath = await createTestPlan('21');

    // Remove dependencies
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        noDependsOn: ['10', '11'],
      },
      {}
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.dependencies).toBeUndefined();
  });

  test('should handle plans without existing issue URLs', async () => {
    const planPath = await createTestPlan('22');

    // Remove issue URLs
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        noIssue: ['https://github.com/owner/repo/issues/123'],
      },
      {}
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.issue).toBeUndefined();
  });
});
