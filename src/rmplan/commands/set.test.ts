import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'yaml';
import { readPlanFile } from '../plans.js';
import { handleSetCommand } from './set.js';
import type { PlanSchema } from '../planSchema.js';
import type { RmplanConfig } from '../configSchema.js';
import { ModuleMocker, clearAllRmplanCaches } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);
const logSpy = mock(() => {});
const warnSpy = mock(() => {});
const errorSpy = mock(() => {});
const removeAssignmentSpy = mock(async () => true);
const getRepositoryIdentitySpy = mock(async () => ({
  repositoryId: 'test-repo',
  remoteUrl: null,
  gitRoot: '',
}));

describe('rmplan set command', () => {
  let tempDir: string;
  let tasksDir: string;
  let globalOpts: any;
  let configPath: string;

  beforeEach(async () => {
    moduleMocker.clear();
    clearAllRmplanCaches();
    logSpy.mockClear();
    warnSpy.mockClear();
    errorSpy.mockClear();
    removeAssignmentSpy.mockClear();
    getRepositoryIdentitySpy.mockClear();

    tempDir = await mkdtemp(path.join(tmpdir(), 'rmplan-set-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    let config: RmplanConfig = {
      paths: {
        tasks: tasksDir,
      },
    };
    await mkdir(tasksDir, { recursive: true });
    configPath = path.join(tempDir, '.rmplan.yml');
    await Bun.file(configPath).write(yaml.stringify(config));
    globalOpts = {
      config: configPath,
    };

    getRepositoryIdentitySpy.mockResolvedValue({
      repositoryId: 'test-repo',
      remoteUrl: null,
      gitRoot: tempDir,
    });

    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      warn: warnSpy,
      error: errorSpy,
    }));

    await moduleMocker.mock('../assignments/assignments_io.js', () => ({
      removeAssignment: removeAssignmentSpy,
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: getRepositoryIdentitySpy,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    clearAllRmplanCaches();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  const createTestPlan = async (id: number, overrides?: Partial<PlanSchema>) => {
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

    if (overrides) {
      Object.assign(plan, overrides);
    }
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
    expect(removeAssignmentSpy).not.toHaveBeenCalled();
  });

  test('removes assignments when status set to done', async () => {
    const planPath = await createTestPlan(111);

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        status: 'done',
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.status).toBe('done');
    expect(removeAssignmentSpy).toHaveBeenCalledTimes(1);
    const [callArgs] = removeAssignmentSpy.mock.calls;
    expect(callArgs[0].uuid).toBe(updatedPlan.uuid);
  });

  test('removes assignments when status set to cancelled', async () => {
    const planPath = await createTestPlan(112);

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        status: 'cancelled',
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.status).toBe('cancelled');
    expect(removeAssignmentSpy).toHaveBeenCalledTimes(1);
    const [callArgs] = removeAssignmentSpy.mock.calls;
    expect(callArgs[0].uuid).toBe(updatedPlan.uuid);
  });

  test('logs warning when assignment removal fails', async () => {
    const planPath = await createTestPlan(113);
    removeAssignmentSpy.mockImplementationOnce(async () => {
      throw new Error('lock failure');
    });

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        status: 'done',
      },
      globalOpts
    );

    const warnings = warnSpy.mock.calls.map((args) => args[0]);
    expect(
      warnings.some((message) =>
        message.includes('Failed to remove assignment for plan 113: lock failure')
      )
    ).toBe(true);
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
    const originalContent = await readFile(planPath, 'utf-8');

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
    // Check that the file content hasn't changed
    const newContent = await readFile(planPath, 'utf-8');
    expect(newContent).toBe(originalContent);

    // The timestamp should be close (within 5ms) if no real changes were made
    const originalTime = new Date(originalPlan.updatedAt!).getTime();
    const newTime = new Date(unchangedPlan.updatedAt!).getTime();
    expect(Math.abs(newTime - originalTime)).toBeLessThan(5);
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
    expect(updatedPlan.dependencies).toEqual([]);
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
    expect(updatedPlan.issue).toEqual([]);
  });

  test('should add documentation paths', async () => {
    const planPath = await createTestPlan(23);

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
    const planPath = await createTestPlan(24);

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
    const planPath = await createTestPlan(25);

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
    const planPath = await createTestPlan(26);

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
    expect(updatedPlan.docs).toEqual([]);
  });

  test('should handle adding and removing documentation paths in same command', async () => {
    const planPath = await createTestPlan(27);

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

  test('should update parent plan dependencies when setting parent', async () => {
    // Create both parent and child plans
    const parentPlanPath = await createTestPlan(200);
    const childPlanPath = await createTestPlan(201);

    await handleSetCommand(
      childPlanPath,
      {
        planFile: childPlanPath,
        parent: 200,
      },
      globalOpts
    );

    // Verify child has parent field set
    const updatedChild = await readPlanFile(childPlanPath);
    expect(updatedChild.parent).toBe(200);

    // Verify parent has child in dependencies array
    const updatedParent = await readPlanFile(parentPlanPath);
    expect(updatedParent.dependencies).toEqual([201]);
    expect(updatedParent.updatedAt).toBeDefined();
  });

  test('should remove child from parent dependencies when removing parent', async () => {
    // Create both parent and child plans
    const parentPlanPath = await createTestPlan(202);
    const childPlanPath = await createTestPlan(203);

    // First set parent relationship
    await handleSetCommand(
      childPlanPath,
      {
        planFile: childPlanPath,
        parent: 202,
      },
      globalOpts
    );

    // Verify relationship is established
    let updatedChild = await readPlanFile(childPlanPath);
    let updatedParent = await readPlanFile(parentPlanPath);
    expect(updatedChild.parent).toBe(202);
    expect(updatedParent.dependencies).toEqual([203]);

    // Remove parent relationship
    await handleSetCommand(
      childPlanPath,
      {
        planFile: childPlanPath,
        noParent: true,
      },
      globalOpts
    );

    // Verify child parent field is removed
    updatedChild = await readPlanFile(childPlanPath);
    expect(updatedChild.parent).toBeUndefined();

    // Verify parent dependencies array is updated
    updatedParent = await readPlanFile(parentPlanPath);
    expect(updatedParent.dependencies).toEqual([]);
  });

  test('should update both old and new parent when changing parent', async () => {
    // Create child, old parent, and new parent plans
    const childPlanPath = await createTestPlan(204);
    const oldParentPlanPath = await createTestPlan(205);
    const newParentPlanPath = await createTestPlan(206);

    // Establish initial relationship with old parent
    await handleSetCommand(
      childPlanPath,
      {
        planFile: childPlanPath,
        parent: 205,
      },
      globalOpts
    );

    // Verify initial relationship
    let updatedChild = await readPlanFile(childPlanPath);
    let oldParent = await readPlanFile(oldParentPlanPath);
    expect(updatedChild.parent).toBe(205);
    expect(oldParent.dependencies).toEqual([204]);

    // Change to new parent
    await handleSetCommand(
      childPlanPath,
      {
        planFile: childPlanPath,
        parent: 206,
      },
      globalOpts
    );

    // Verify child has new parent
    updatedChild = await readPlanFile(childPlanPath);
    expect(updatedChild.parent).toBe(206);

    // Verify old parent no longer has child in dependencies
    oldParent = await readPlanFile(oldParentPlanPath);
    expect(oldParent.dependencies).toEqual([]);

    // Verify new parent has child in dependencies
    const newParent = await readPlanFile(newParentPlanPath);
    expect(newParent.dependencies).toEqual([204]);
  });

  test('should prevent circular dependencies when setting parent', async () => {
    // Create three plans to set up a circular dependency scenario
    const planAPath = await createTestPlan(207);
    const planBPath = await createTestPlan(208);
    const planCPath = await createTestPlan(209);

    // Create a dependency chain: B -> C -> A
    await handleSetCommand(
      planBPath,
      {
        planFile: planBPath,
        dependsOn: [209],
      },
      globalOpts
    );

    await handleSetCommand(
      planCPath,
      {
        planFile: planCPath,
        dependsOn: [207],
      },
      globalOpts
    );

    // Verify the dependency chain exists: B depends on C, C depends on A
    const planB = await readPlanFile(planBPath);
    const planC = await readPlanFile(planCPath);
    expect(planB.dependencies).toEqual([209]);
    expect(planC.dependencies).toEqual([207]);

    // Now if we try to set plan B's parent to plan A, it would create a cycle:
    // A -> B (via parent-child) but B -> C -> A (via dependencies), creating A -> B -> C -> A
    await expect(
      handleSetCommand(
        planBPath,
        {
          planFile: planBPath,
          parent: 207,
        },
        globalOpts
      )
    ).rejects.toThrow('Setting parent 207 would create a circular dependency');

    // Verify plan B still has no parent
    const updatedPlanB = await readPlanFile(planBPath);
    expect(updatedPlanB.parent).toBeUndefined();
  });

  test('should handle setting parent to same value without duplicating dependencies', async () => {
    // Create parent and child plans
    const parentPlanPath = await createTestPlan(210);
    const childPlanPath = await createTestPlan(211);

    // Set parent first time
    await handleSetCommand(
      childPlanPath,
      {
        planFile: childPlanPath,
        parent: 210,
      },
      globalOpts
    );

    // Verify initial relationship
    let updatedChild = await readPlanFile(childPlanPath);
    let updatedParent = await readPlanFile(parentPlanPath);
    expect(updatedChild.parent).toBe(210);
    expect(updatedParent.dependencies).toEqual([211]);

    // Set same parent again
    await handleSetCommand(
      childPlanPath,
      {
        planFile: childPlanPath,
        parent: 210,
      },
      globalOpts
    );

    // Verify no duplicate dependencies
    updatedChild = await readPlanFile(childPlanPath);
    updatedParent = await readPlanFile(parentPlanPath);
    expect(updatedChild.parent).toBe(210);
    expect(updatedParent.dependencies).toEqual([211]); // Should still be [211], not [211, 211]
  });

  test('should set discoveredFrom field', async () => {
    const planPath = await createTestPlan(40);

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        discoveredFrom: 38,
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.discoveredFrom).toBe(38);
    expect(updatedPlan.updatedAt).toBeDefined();
  });

  test('should remove discoveredFrom field', async () => {
    const planPath = await createTestPlan(41);

    // First set discoveredFrom
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        discoveredFrom: 38,
      },
      globalOpts
    );

    let updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.discoveredFrom).toBe(38);

    // Then remove it
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        noDiscoveredFrom: true,
      },
      globalOpts
    );

    updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.discoveredFrom).toBeUndefined();
  });

  test('should handle removing discoveredFrom when none exists', async () => {
    const planPath = await createTestPlan(42);

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        noDiscoveredFrom: true,
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.discoveredFrom).toBeUndefined();
  });

  test('should allow changing discoveredFrom value', async () => {
    const planPath = await createTestPlan(43);

    // First set discoveredFrom to 38
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        discoveredFrom: 38,
      },
      globalOpts
    );

    let updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.discoveredFrom).toBe(38);

    // Change it to 39
    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        discoveredFrom: 39,
      },
      globalOpts
    );

    updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.discoveredFrom).toBe(39);
  });

  test('adds tags with normalization and deduplication', async () => {
    const planPath = await createTestPlan(200);

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        tag: ['Frontend', 'frontend', 'Urgent', ''],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.tags).toEqual(['frontend', 'urgent']);
  });

  test('removes specified tags', async () => {
    const planPath = await createTestPlan(201, { tags: ['frontend', 'bug', 'urgent'] });

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        noTag: ['BUG'],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.tags).toEqual(['frontend', 'urgent']);
  });

  test('supports adding and removing tags in one command', async () => {
    const planPath = await createTestPlan(202, { tags: ['frontend'] });

    await handleSetCommand(
      planPath,
      {
        planFile: planPath,
        tag: ['Bug'],
        noTag: ['frontend'],
      },
      globalOpts
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.tags).toEqual(['bug']);
  });

  test('rejects tags not in allowlist', async () => {
    await Bun.file(configPath).write(
      yaml.stringify({
        paths: { tasks: tasksDir },
        tags: { allowed: ['frontend', 'backend'] },
      })
    );
    clearAllRmplanCaches();

    const planPath = await createTestPlan(203);

    await expect(
      handleSetCommand(
        planPath,
        {
          planFile: planPath,
          tag: ['urgent'],
        },
        globalOpts
      )
    ).rejects.toThrow(/Invalid tag/);
  });
});
