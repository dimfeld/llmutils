import { vi, describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'yaml';
import {
  findNextPlan,
  readAllPlans,
  resolvePlanFile,
  setPlanStatus,
  clearPlanCache,
  readPlanFile,
  writePlanFile,
  getBlockedPlans,
  getChildPlans,
  getDiscoveredPlans,
} from './plans.js';
import { planSchema, type PlanSchema } from './planSchema.js';
import { ModuleMocker } from '../testing.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const moduleMocker = new ModuleMocker(import.meta);

describe('resolvePlanFile', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Create a temporary directory for test files
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'rmplan-test-')));
    tasksDir = join(tempDir, 'tasks');
    await mkdir(tasksDir, { recursive: true });

    // Clear the plan cache before tests
    clearPlanCache();

    // Set up module mocks with a getter to ensure tasksDir is evaluated lazily
    await moduleMocker.mock('./configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          get tasks() {
            return tasksDir;
          },
        },
      }),
    }));

    // Create test plan files
    const plan1 = {
      id: 1,
      title: 'Test Plan 1',
      goal: 'Test goal 1',
      details: 'Details for test plan 1',
      status: 'pending',
      priority: 'medium',
      tasks: [],
    };

    const plan2 = {
      id: 2,
      title: 'Implement Authentication',
      goal: 'Add authentication system',
      details: 'Add authentication to the application',
      status: 'in_progress',
      priority: 'high',
      dependencies: [1],
      tasks: [],
    };

    const planWithoutId = {
      title: 'Plan without ID',
      goal: 'This plan has no ID',
      details: 'Details for plan without ID',
      tasks: [],
    };

    await writeFile(join(tasksDir, '1.yml'), yaml.stringify(plan1));
    await writeFile(join(tasksDir, '2.yml'), yaml.stringify(plan2));
    await writeFile(join(tasksDir, 'no-id.yml'), yaml.stringify(planWithoutId));

    // Create a plan outside the tasks dir
    await writeFile(join(tempDir, 'outside-plan.yml'), yaml.stringify(plan1));
  });

  afterAll(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up temporary directory
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should resolve an absolute file path that exists', async () => {
    const absolutePath = join(tasksDir, '1.yml');
    const resolved = await resolvePlanFile(absolutePath);
    expect(resolved).toBe(absolutePath);
  });

  it('should resolve a relative file path that exists', async () => {
    const originalCwd = process.cwd();
    process.chdir(tasksDir);

    try {
      const resolved = await resolvePlanFile('./1.yml');
      expect(resolved).toBe(join(tasksDir, '1.yml'));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should resolve a plan ID to the correct file', async () => {
    const resolved = await resolvePlanFile('1');
    expect(resolved).toBe(join(tasksDir, '1.yml'));
  });

  it('should resolve a plan ID with dashes', async () => {
    const resolved = await resolvePlanFile('2');
    expect(resolved).toBe(join(tasksDir, '2.yml'));
  });

  it('should throw error for non-existent file path', async () => {
    await expect(resolvePlanFile('./non-existent.yml')).rejects.toThrow(
      'Plan file not found: ./non-existent.yml'
    );
  });

  it('should throw error for non-existent plan ID', async () => {
    await expect(resolvePlanFile('non-existent-id')).rejects.toThrow(
      'No plan found with ID or file path: non-existent-id'
    );
  });

  it('should handle plans in nested directories', async () => {
    // Create a nested directory with a plan
    const nestedDir = join(tasksDir, 'nested');
    await mkdir(nestedDir, { recursive: true });

    const nestedPlan = {
      id: 3,
      title: 'Nested Plan',
      goal: 'Test nested directory',
      details: 'Details for nested plan',
      tasks: [],
    };

    await writeFile(join(nestedDir, 'nested-plan.yml'), yaml.stringify(nestedPlan));

    // Clear cache to ensure the new file is found
    clearPlanCache();

    const resolved = await resolvePlanFile('3');
    expect(resolved).toBe(join(nestedDir, 'nested-plan.yml'));
  });

  it('should resolve by a numeric string ID that corresponds to an existing [ID].yml file', async () => {
    // Create a numeric plan file with format [ID].yml
    const numericPlan = {
      id: 101,
      title: 'Numeric Plan 101',
      goal: 'Test numeric ID',
      details: 'Details for numeric plan',
      status: 'pending',
      tasks: [],
    };

    await writeFile(join(tasksDir, '101.yml'), yaml.stringify(numericPlan));

    // Clear cache to ensure the new file is found
    clearPlanCache();

    const resolved = await resolvePlanFile('101');
    expect(resolved).toBe(join(tasksDir, '101.yml'));
  });

  it('should resolve by a numeric string ID where [ID].yml does not exist but another file contains that ID', async () => {
    // Create a plan with numeric ID 102 but in a different filename
    const numericPlan = {
      id: 102,
      title: 'Numeric Plan 102',
      goal: 'Test numeric ID in different file',
      details: 'Details for numeric plan',
      status: 'pending',
      tasks: [],
    };

    await writeFile(join(tasksDir, 'my-plan.yml'), yaml.stringify(numericPlan));

    // Clear cache to ensure the new file is found
    clearPlanCache();

    const resolved = await resolvePlanFile('102');
    expect(resolved).toBe(join(tasksDir, 'my-plan.yml'));
  });

  it('should resolve by providing the direct filename [ID].yml', async () => {
    // Create a numeric plan file
    const numericPlan = {
      id: 103,
      title: 'Numeric Plan 103',
      goal: 'Test direct filename',
      details: 'Details for numeric plan',
      status: 'pending',
      tasks: [],
    };

    await writeFile(join(tasksDir, '103.yml'), yaml.stringify(numericPlan));

    // Clear cache to ensure the new file is found
    clearPlanCache();

    const resolved = await resolvePlanFile('103.yml');
    expect(resolved).toBe(join(tasksDir, '103.yml'));
  });

  it('should throw an error if the plan ID or filename cannot be resolved', async () => {
    await expect(resolvePlanFile('999')).rejects.toThrow('No plan found with ID or file path: 999');

    await expect(resolvePlanFile('non-existent-plan-id')).rejects.toThrow(
      'No plan found with ID or file path: non-existent-plan-id'
    );
  });
});

describe('Plan relationship utilities', () => {
  const createPlan = (
    id: number,
    overrides: Partial<PlanSchema & { filename: string }> = {}
  ): PlanSchema & { filename: string } => ({
    id,
    title: `Plan ${id}`,
    goal: `Goal ${id}`,
    details: `Details ${id}`,
    status: 'pending',
    tasks: [],
    filename: `tasks/${id}.plan.yml`,
    ...overrides,
  });

  const toPlanMap = (
    plans: Array<PlanSchema & { filename: string }>
  ): Map<number, PlanSchema & { filename: string }> =>
    new Map<number, PlanSchema & { filename: string }>(plans.map((plan) => [plan.id!, plan]));

  describe('getBlockedPlans', () => {
    it('returns plans that depend on the target plan', () => {
      const plans = toPlanMap([createPlan(1), createPlan(2, { dependencies: [1] }), createPlan(3)]);

      const blocked = getBlockedPlans(1, plans).map((plan) => plan.id);
      expect(blocked).toEqual([2]);
    });

    it('returns empty array when no dependents exist', () => {
      const plans = toPlanMap([createPlan(1), createPlan(2, { dependencies: [3] })]);

      const blocked = getBlockedPlans(1, plans);
      expect(blocked).toHaveLength(0);
    });

    it('handles multiple dependents correctly', () => {
      const plans = toPlanMap([
        createPlan(1),
        createPlan(2, { dependencies: [1] }),
        createPlan(3, { dependencies: [1, 4] }),
        createPlan(4, { dependencies: [] }),
      ]);

      const blocked = getBlockedPlans(1, plans).map((plan) => plan.id);
      expect(blocked).toHaveLength(2);
      expect(blocked).toEqual(expect.arrayContaining([2, 3]));
    });

    it('works with empty plan map', () => {
      const blocked = getBlockedPlans(1, new Map());
      expect(blocked).toEqual([]);
    });
  });

  describe('getChildPlans', () => {
    it('returns direct children of the parent plan', () => {
      const plans = toPlanMap([createPlan(1), createPlan(2, { parent: 1 }), createPlan(3)]);

      const children = getChildPlans(1, plans).map((plan) => plan.id);
      expect(children).toEqual([2]);
    });

    it('returns empty array when no children exist', () => {
      const plans = toPlanMap([createPlan(1), createPlan(2, { parent: 3 })]);

      const children = getChildPlans(1, plans);
      expect(children).toHaveLength(0);
    });

    it('handles multiple children correctly', () => {
      const plans = toPlanMap([
        createPlan(1),
        createPlan(2, { parent: 1 }),
        createPlan(3, { parent: 1 }),
        createPlan(4, { parent: 2 }),
      ]);

      const children = getChildPlans(1, plans).map((plan) => plan.id);
      expect(children).toHaveLength(2);
      expect(children).toEqual(expect.arrayContaining([2, 3]));
    });

    it('does not return grandchildren', () => {
      const plans = toPlanMap([
        createPlan(1),
        createPlan(2, { parent: 1 }),
        createPlan(3, { parent: 2 }),
      ]);

      const children = getChildPlans(1, plans).map((plan) => plan.id);
      expect(children).toEqual([2]);
      expect(children).not.toContain(3);
    });

    it('works with empty plan map', () => {
      const children = getChildPlans(1, new Map());
      expect(children).toEqual([]);
    });
  });

  describe('getDiscoveredPlans', () => {
    it('returns plans discovered from the source plan', () => {
      const plans = toPlanMap([createPlan(1), createPlan(2, { discoveredFrom: 1 }), createPlan(3)]);

      const discovered = getDiscoveredPlans(1, plans).map((plan) => plan.id);
      expect(discovered).toEqual([2]);
    });

    it('returns empty array when no discoveries exist', () => {
      const plans = toPlanMap([createPlan(1), createPlan(2, { discoveredFrom: 3 })]);

      const discovered = getDiscoveredPlans(1, plans);
      expect(discovered).toHaveLength(0);
    });

    it('handles multiple discovered plans correctly', () => {
      const plans = toPlanMap([
        createPlan(1),
        createPlan(2, { discoveredFrom: 1 }),
        createPlan(3, { discoveredFrom: 1 }),
        createPlan(4, { discoveredFrom: 2 }),
      ]);

      const discovered = getDiscoveredPlans(1, plans).map((plan) => plan.id);
      expect(discovered).toHaveLength(2);
      expect(discovered).toEqual(expect.arrayContaining([2, 3]));
    });

    it('works with empty plan map', () => {
      const discovered = getDiscoveredPlans(1, new Map());
      expect(discovered).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('handles circular relationships without infinite recursion', () => {
      const plans = toPlanMap([
        createPlan(1, { dependencies: [2], parent: 2, discoveredFrom: 2 }),
        createPlan(2, { dependencies: [1], parent: 1, discoveredFrom: 1 }),
      ]);

      const blocked = getBlockedPlans(1, plans).map((plan) => plan.id);
      const children = getChildPlans(1, plans).map((plan) => plan.id);
      const discovered = getDiscoveredPlans(1, plans).map((plan) => plan.id);

      expect(blocked).toEqual([2]);
      expect(children).toEqual([2]);
      expect(discovered).toEqual([2]);
    });

    it('handles missing plan references gracefully', () => {
      const plans = toPlanMap([
        createPlan(10, { dependencies: [999], parent: 999, discoveredFrom: 999 }),
      ]);

      const blocked = getBlockedPlans(999, plans).map((plan) => plan.id);
      const children = getChildPlans(999, plans).map((plan) => plan.id);
      const discovered = getDiscoveredPlans(999, plans).map((plan) => plan.id);

      expect(blocked).toEqual([10]);
      expect(children).toEqual([10]);
      expect(discovered).toEqual([10]);
    });

    it('scales to large plan collections', () => {
      const plans = new Map<number, PlanSchema & { filename: string }>();
      plans.set(1, createPlan(1));

      for (let id = 2; id <= 51; id++) {
        plans.set(id, createPlan(id, { dependencies: [1] }));
      }

      for (let id = 52; id <= 101; id++) {
        plans.set(id, createPlan(id, { parent: 1 }));
      }

      for (let id = 102; id <= 151; id++) {
        plans.set(id, createPlan(id, { discoveredFrom: 1 }));
      }

      const blocked = getBlockedPlans(1, plans);
      const children = getChildPlans(1, plans);
      const discovered = getDiscoveredPlans(1, plans);

      expect(blocked).toHaveLength(50);
      expect(children).toHaveLength(50);
      expect(discovered).toHaveLength(50);

      expect(blocked.every((plan) => plan.dependencies?.includes(1))).toBe(true);
      expect(children.every((plan) => plan.parent === 1)).toBe(true);
      expect(discovered.every((plan) => plan.discoveredFrom === 1)).toBe(true);
    });
  });
});

describe('plan UUID handling', () => {
  it('generates and persists UUIDs for legacy plans without one', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'rmplan-uuid-'));
    try {
      const planPath = join(tempDir, 'legacy.yml');
      await writeFile(
        planPath,
        yaml.stringify({
          id: 123,
          title: 'Legacy Plan',
          goal: 'Add UUID support',
          details: 'This plan predates UUIDs',
          status: 'pending',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          tasks: [],
        })
      );

      clearPlanCache();
      const uuidSpy = vi
        .spyOn(crypto, 'randomUUID')
        .mockReturnValue('11111111-1111-4111-8111-111111111111');

      let plan: PlanSchema;
      try {
        plan = await readPlanFile(planPath);
      } finally {
        uuidSpy.mockRestore();
      }
      expect(plan.uuid).toBe('11111111-1111-4111-8111-111111111111');

      const savedContent = await readFile(planPath, 'utf8');
      expect(savedContent).toContain('uuid: 11111111-1111-4111-8111-111111111111');

      const rereadPlan = await readPlanFile(planPath);
      expect(rereadPlan.uuid).toBe(plan.uuid);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('readAllPlans', () => {
  let tempDir: string;

  beforeAll(async () => {
    // Clear the plan cache before tests
    clearPlanCache();

    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'rmplan-readall-test-')));

    // Create test structure
    const subDir = join(tempDir, 'subdir');
    await mkdir(subDir, { recursive: true });

    // Create various test files
    const plans = [
      {
        filename: 'plan1.yml',
        content: {
          id: 1,
          title: 'Plan 1',
          goal: 'Goal 1',
          details: 'Details for plan 1',
          status: 'pending',
          priority: 'high',
          tasks: [],
        },
      },
      {
        filename: 'plan2.yaml',
        content: {
          id: 2,
          title: 'Plan 2',
          goal: 'Goal 2',
          details: 'Details for plan 2',
          status: 'done',
          dependencies: [1],
          tasks: [],
        },
      },
      {
        filename: join('subdir', 'nested.yml'),
        content: {
          id: 3,
          title: 'Nested Plan',
          goal: 'Nested goal',
          details: 'Details for nested plan',
          tasks: [],
        },
      },
      {
        filename: 'no-id.yml',
        content: {
          title: 'No ID',
          goal: 'This has no ID',
          details: 'Details for no ID',
          tasks: [],
        },
      },
      {
        filename: 'invalid.yml',
        content: 'invalid yaml content {',
      },
      {
        filename: 'not-yaml.txt',
        content: 'This is not a YAML file',
      },
    ];

    for (const { filename, content } of plans) {
      const fullPath = join(tempDir, filename);
      if (typeof content === 'string') {
        await writeFile(fullPath, content);
      } else {
        await writeFile(fullPath, yaml.stringify(content));
      }
    }
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should read all valid plan files recursively', async () => {
    const { plans, maxNumericId } = await readAllPlans(tempDir);

    expect(plans.size).toBe(3);
    expect(plans.has(1)).toBe(true);
    expect(plans.has(2)).toBe(true);
    expect(plans.has(3)).toBe(true);

    // The no-id.yml file should not be included
    const generatedIdPlan = Array.from(plans.values()).find((p) =>
      p.filename.endsWith('no-id.yml')
    );
    expect(generatedIdPlan).toBeUndefined();

    // Since all IDs are numeric, maxNumericId should be 3
    expect(maxNumericId).toBe(3);
  });

  it('should include correct plan summaries', async () => {
    const { plans } = await readAllPlans(tempDir);

    const plan1 = plans.get(1);
    expect(plan1).toBeDefined();
    expect(plan1!.title).toBe('Plan 1');
    expect(plan1!.goal).toBe('Goal 1');
    expect(plan1!.status).toBe('pending');
    expect(plan1!.priority).toBe('high');
    expect(plan1!.filename).toBe(join(tempDir, 'plan1.yml'));

    const plan2 = plans.get(2);
    expect(plan2).toBeDefined();
    expect(plan2!.status).toBe('done');
    expect(plan2!.dependencies).toEqual([1]);
  });

  it('should handle empty directories', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'empty-'));
    try {
      const { plans, maxNumericId } = await readAllPlans(emptyDir);
      expect(plans.size).toBe(0);
      expect(maxNumericId).toBe(0);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('should handle numeric IDs and calculate maxNumericId correctly', async () => {
    const numericIdDir = await mkdtemp(join(tmpdir(), 'numeric-id-test-'));
    try {
      // Create plans with numeric IDs
      const plans = [
        { id: 100, title: 'Plan 100', goal: 'Test', details: 'Test', tasks: [] },
        { id: 50, title: 'Plan 50', goal: 'Test', details: 'Test', tasks: [] },
        { id: 75, title: 'Plan 75', goal: 'Test', details: 'Test', tasks: [] },
      ];

      for (const plan of plans) {
        await writeFile(join(numericIdDir, `${plan.id}.yml`), yaml.stringify(plan));
      }

      const { plans: readPlans, maxNumericId } = await readAllPlans(numericIdDir);

      // Check that numeric IDs are stored as numbers
      expect(readPlans.get(100)).toBeDefined();
      expect(readPlans.get(100)!.id).toBe(100);
      expect(typeof readPlans.get(100)!.id).toBe('number');

      expect(readPlans.get(50)).toBeDefined();
      expect(readPlans.get(50)!.id).toBe(50);

      expect(readPlans.get(75)).toBeDefined();
      expect(readPlans.get(75)!.id).toBe(75);

      // maxNumericId should be the highest numeric ID
      expect(maxNumericId).toBe(100);
    } finally {
      await rm(numericIdDir, { recursive: true, force: true });
    }
  });

  it('should handle invalid YAML and empty files gracefully', async () => {
    const errorTestDir = await mkdtemp(join(tmpdir(), 'error-test-'));
    try {
      // Create some valid plans
      await writeFile(
        join(errorTestDir, 'valid.yml'),
        yaml.stringify({ id: 200, title: 'Valid', goal: 'Test', details: 'Test', tasks: [] })
      );

      // Create invalid YAML
      await writeFile(join(errorTestDir, 'invalid.yml'), '{ invalid yaml: }}}');

      // Create empty file
      await writeFile(join(errorTestDir, 'empty.yml'), '');

      // Should still read the valid plan
      const { plans, maxNumericId } = await readAllPlans(errorTestDir);

      expect(plans.size).toBe(1);
      expect(plans.get(200)).toBeDefined();
      expect(maxNumericId).toBe(200);
    } finally {
      await rm(errorTestDir, { recursive: true, force: true });
    }
  });

  it('should handle plans without IDs correctly', async () => {
    const mixedIdDir = await mkdtemp(join(tmpdir(), 'mixed-id-test-'));
    try {
      // Create plans with and without IDs
      await writeFile(
        join(mixedIdDir, 'with-id.yml'),
        yaml.stringify({ id: 300, title: 'With ID', goal: 'Test', details: 'Test', tasks: [] })
      );

      await writeFile(
        join(mixedIdDir, 'no-id.yml'),
        yaml.stringify({ title: 'No ID', goal: 'Test', details: 'Test', tasks: [] })
      );

      const { plans, maxNumericId } = await readAllPlans(mixedIdDir);

      // Only the plan with ID should be included
      expect(plans.size).toBe(1);
      expect(plans.get(300)).toBeDefined();
      expect(maxNumericId).toBe(300);
    } finally {
      await rm(mixedIdDir, { recursive: true, force: true });
    }
  });
});

describe('findNextReadyPlan', () => {
  let tempDir: string;

  beforeAll(async () => {
    // Clear the plan cache before tests
    clearPlanCache();

    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'rmplan-findnext-test-')));

    // Create test plans with various priorities and dependencies
    const plans = [
      {
        filename: 'low-priority-1.yml',
        content: {
          id: 1,
          title: 'Low Priority 1',
          goal: 'Low priority goal',
          details: 'Details',
          status: 'pending',
          priority: 'low',
          tasks: [],
        },
      },
      {
        filename: 'urgent-priority.yml',
        content: {
          id: 2,
          title: 'Urgent Priority',
          goal: 'Urgent goal',
          details: 'Details',
          status: 'pending',
          priority: 'urgent',
          tasks: [],
        },
      },
      {
        filename: 'medium-priority.yml',
        content: {
          id: 3,
          title: 'Medium Priority',
          goal: 'Medium goal',
          details: 'Details',
          status: 'pending',
          priority: 'medium',
          tasks: [],
        },
      },
      {
        filename: 'high-priority.yml',
        content: {
          id: 4,
          title: 'High Priority',
          goal: 'High goal',
          details: 'Details',
          status: 'pending',
          priority: 'high',
          tasks: [],
        },
      },
      {
        filename: 'no-priority.yml',
        content: {
          id: 5,
          title: 'No Priority',
          goal: 'No priority goal',
          details: 'Details',
          status: 'pending',
          tasks: [],
        },
      },
      {
        filename: 'high-priority-2.yml',
        content: {
          id: 6,
          title: 'High Priority 2',
          goal: 'Second high priority goal',
          details: 'Details',
          status: 'pending',
          priority: 'high',
          tasks: [],
        },
      },
      {
        filename: 'done-plan.yml',
        content: {
          id: 7,
          title: 'Done Plan',
          goal: 'Already done',
          details: 'Details',
          status: 'done',
          priority: 'urgent',
          tasks: [],
        },
      },
      {
        filename: 'blocked-plan.yml',
        content: {
          id: 8,
          title: 'Blocked Plan',
          goal: 'Blocked by dependency',
          details: 'Details',
          status: 'pending',
          priority: 'urgent',
          dependencies: [7, 1], // low-1 is not done, so this is blocked
          tasks: [],
        },
      },
      {
        filename: 'ready-with-deps.yml',
        content: {
          id: 9,
          title: 'Ready with Dependencies',
          goal: 'Has dependencies but they are done',
          details: 'Details',
          status: 'pending',
          priority: 'medium',
          dependencies: [7], // done-1 is done, so this is ready
          tasks: [],
        },
      },
    ];

    for (const { filename, content } of plans) {
      await writeFile(join(tempDir, filename), yaml.stringify(content));
    }
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should return the highest priority ready plan', async () => {
    const nextPlan = await findNextPlan(tempDir, { includePending: true });
    expect(nextPlan).toBeDefined();
    expect(nextPlan!.id).toBe(2);
  });

  it('should sort by ID when priorities are equal', async () => {
    // Remove the urgent plan to test high priority sorting
    await rm(join(tempDir, 'urgent-priority.yml'));

    // Clear cache after file removal to ensure fresh read
    clearPlanCache();

    const nextPlan = await findNextPlan(tempDir, { includePending: true });
    expect(nextPlan).toBeDefined();
    expect(nextPlan!.id).toBe(4); // Plan 4 comes before plan 6
  });

  it('should skip blocked plans even if they have high priority', async () => {
    // The blocked-1 plan has urgent priority but depends on low-1 which is not done
    const { plans } = await readAllPlans(tempDir);
    const blockedPlan = plans.get(8);
    expect(blockedPlan).toBeDefined();
    expect(blockedPlan!.priority).toBe('urgent');

    // But it should not be returned as the next plan
    const nextPlan = await findNextPlan(tempDir, { includePending: true });
    expect(nextPlan).toBeDefined();
    expect(nextPlan!.id).not.toBe(8);
  });

  it('should include plans with all dependencies done', async () => {
    const { plans } = await readAllPlans(tempDir);
    const readyWithDeps = plans.get(9);
    expect(readyWithDeps).toBeDefined();
    expect(readyWithDeps!.dependencies).toEqual([7]);

    // Create a fresh directory with only the dependency test plans
    const depTestDir = await mkdtemp(join(tmpdir(), 'dep-test-'));
    try {
      await writeFile(
        join(depTestDir, 'done-dep.yml'),
        yaml.stringify({
          id: 10,
          title: 'Done Dependency',
          goal: 'Already done',
          details: 'Details',
          status: 'done',
          tasks: [],
        })
      );

      await writeFile(
        join(depTestDir, 'ready-with-deps.yml'),
        yaml.stringify({
          id: 11,
          title: 'Ready with Dependencies',
          goal: 'Has dependencies but they are done',
          details: 'Details',
          status: 'pending',
          priority: 'medium',
          dependencies: [10],
          tasks: [],
        })
      );

      const nextPlan = await findNextPlan(depTestDir, { includePending: true });
      expect(nextPlan).toBeDefined();
      expect(nextPlan!.id).toBe(11);
    } finally {
      await rm(depTestDir, { recursive: true, force: true });
    }
  });

  it('should return null when no plans are ready', async () => {
    // Create a directory with only done plans
    const doneDir = await mkdtemp(join(tmpdir(), 'done-'));
    try {
      await writeFile(
        join(doneDir, 'done.yml'),
        yaml.stringify({
          id: 12,
          title: 'Done',
          goal: 'Already done',
          details: 'Details',
          status: 'done',
          tasks: [],
        })
      );

      const nextPlan = await findNextPlan(doneDir, { includePending: true });
      expect(nextPlan).toBeNull();
    } finally {
      await rm(doneDir, { recursive: true, force: true });
    }
  });

  it('should prioritize plans without priority lower than those with low priority', async () => {
    // Create a fresh directory with only no-priority and low-priority plans
    const priorityTestDir = await mkdtemp(join(tmpdir(), 'priority-test-'));
    try {
      await writeFile(
        join(priorityTestDir, 'no-priority.yml'),
        yaml.stringify({
          id: 13,
          title: 'No Priority',
          goal: 'No priority goal',
          details: 'Details',
          status: 'pending',
          tasks: [],
        })
      );

      await writeFile(
        join(priorityTestDir, 'low-priority.yml'),
        yaml.stringify({
          id: 14,
          title: 'Low Priority',
          goal: 'Low priority goal',
          details: 'Details',
          status: 'pending',
          priority: 'low',
          tasks: [],
        })
      );

      const nextPlan = await findNextPlan(priorityTestDir, { includePending: true });
      expect(nextPlan).toBeDefined();
      expect(nextPlan!.id).toBe(14); // Low priority is higher than no priority
    } finally {
      await rm(priorityTestDir, { recursive: true, force: true });
    }
  });
});

describe('setPlanStatus', () => {
  let tempDir: string;

  beforeAll(async () => {
    // Clear the plan cache before tests
    clearPlanCache();

    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'rmplan-setstatus-test-')));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should successfully update status and updatedAt for a valid plan', async () => {
    const planPath = join(tempDir, 'test-plan.yml');
    const originalPlan: PlanSchema = {
      id: 15,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      priority: 'medium',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      tasks: [],
    };

    await writeFile(planPath, yaml.stringify(originalPlan));

    const beforeTime = new Date();
    await setPlanStatus(planPath, 'in_progress');
    const afterTime = new Date();

    const updatedPlan = await readPlanFile(planPath);

    expect(updatedPlan.status).toBe('in_progress');
    expect(updatedPlan.id).toBe(originalPlan.id);
    expect(updatedPlan.title).toBe(originalPlan.title);
    expect(updatedPlan.goal).toBe(originalPlan.goal);
    expect(updatedPlan.details).toBe(originalPlan.details);
    expect(updatedPlan.priority).toBe(originalPlan.priority);
    expect(updatedPlan.createdAt).toBe(originalPlan.createdAt);

    // Check that updatedAt is more recent
    const updatedAt = new Date(updatedPlan.updatedAt!);
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
    expect(updatedAt.getTime()).toBeLessThanOrEqual(afterTime.getTime());
  });

  it('should handle non-existent plan files', async () => {
    const nonExistentPath = join(tempDir, 'non-existent.yml');

    await expect(setPlanStatus(nonExistentPath, 'done')).rejects.toThrow();
  });

  it('should handle files that are not valid YAML', async () => {
    const invalidYamlPath = join(tempDir, 'invalid.yml');
    await writeFile(invalidYamlPath, 'invalid yaml content {{{');

    await expect(setPlanStatus(invalidYamlPath, 'done')).rejects.toThrow();
  });

  it('should ensure updatedAt is more recent after an update', async () => {
    const planPath = join(tempDir, 'time-test-plan.yml');
    const originalTime = '2024-01-01T00:00:00.000Z';
    const originalPlan: PlanSchema = {
      id: 16,
      title: 'Time Test Plan',
      goal: 'Test time update',
      details: 'Test details',
      status: 'pending',
      updatedAt: originalTime,
      tasks: [],
    };

    await writeFile(planPath, yaml.stringify(originalPlan));

    // Wait a bit to ensure time difference
    await new Promise((resolve) => setTimeout(resolve, 10));

    await setPlanStatus(planPath, 'done');

    const updatedPlan = await readPlanFile(planPath);

    expect(new Date(updatedPlan.updatedAt!).getTime()).toBeGreaterThan(
      new Date(originalTime).getTime()
    );
  });

  it('should handle plans without updatedAt field', async () => {
    const planPath = join(tempDir, 'no-updatedat-plan.yml');
    const originalPlan: PlanSchema = {
      id: 17,
      title: 'No UpdatedAt Plan',
      goal: 'Test without updatedAt',
      details: 'Test details',
      status: 'pending',
      tasks: [],
    };

    await writeFile(planPath, yaml.stringify(originalPlan));

    const beforeTime = new Date();
    await setPlanStatus(planPath, 'in_progress');

    const updatedPlan = await readPlanFile(planPath);

    expect(updatedPlan.status).toBe('in_progress');
    expect(updatedPlan.updatedAt).toBeDefined();

    const updatedAt = new Date(updatedPlan.updatedAt!);
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
  });

  it('should validate against plan schema and throw on invalid structure', async () => {
    const invalidPlanPath = join(tempDir, 'invalid-plan.yml');
    const invalidPlan = {
      // Missing required fields like 'goal' and 'details'
      id: 'invalid',
      title: 'Invalid Plan',
      tasks: 'not-an-array', // Invalid type
    };

    await writeFile(invalidPlanPath, yaml.stringify(invalidPlan));

    await expect(setPlanStatus(invalidPlanPath, 'done')).rejects.toThrow();
  });

  it('should handle empty YAML file', async () => {
    const emptyPath = join(tempDir, 'empty.yml');
    await writeFile(emptyPath, '');

    await expect(setPlanStatus(emptyPath, 'done')).rejects.toThrow();
  });

  it('should handle file with only comments', async () => {
    const commentOnlyPath = join(tempDir, 'comments-only.yml');
    await writeFile(commentOnlyPath, '# Just a comment\n# Another comment');

    await expect(setPlanStatus(commentOnlyPath, 'done')).rejects.toThrow();
  });

  it('should preserve other fields when updating status', async () => {
    const planPath = join(tempDir, 'preserve-fields.yml');
    const originalPlan: PlanSchema = {
      id: 18,
      title: 'Preserve Fields Test',
      goal: 'Test field preservation',
      details: 'Detailed description',
      status: 'pending',
      priority: 'high',
      dependencies: [19, 20],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      tasks: [
        {
          title: 'Task 1',
          description: 'Task description',
          files: [],
          done: false,
          steps: [
            { prompt: 'Step 1', done: true },
            { prompt: 'Step 2', done: false },
          ],
        },
      ],
    };

    await writeFile(planPath, yaml.stringify(originalPlan));

    await setPlanStatus(planPath, 'in_progress');

    const updatedPlan = await readPlanFile(planPath);

    // Check that all fields are preserved
    expect(updatedPlan.id).toBe(originalPlan.id);
    expect(updatedPlan.title).toBe(originalPlan.title);
    expect(updatedPlan.goal).toBe(originalPlan.goal);
    expect(updatedPlan.details).toBe(originalPlan.details);
    expect(updatedPlan.priority).toBe(originalPlan.priority);
    expect(updatedPlan.dependencies).toEqual(originalPlan.dependencies);
    expect(updatedPlan.createdAt).toBe(originalPlan.createdAt);
    expect(updatedPlan.tasks).toEqual(originalPlan.tasks);

    // Only status and updatedAt should change
    expect(updatedPlan.status).toBe('in_progress');
    expect(updatedPlan.updatedAt).not.toBe(originalPlan.updatedAt);
  });

  it('should handle concurrent updates gracefully', async () => {
    const planPath = join(tempDir, 'concurrent-test.yml');
    const originalPlan: PlanSchema = {
      id: 21,
      title: 'Concurrent Test',
      goal: 'Test concurrent updates',
      details: 'Testing',
      status: 'pending',
      tasks: [],
    };

    await writeFile(planPath, yaml.stringify(originalPlan));

    // Attempt concurrent updates
    const promises = [
      setPlanStatus(planPath, 'in_progress'),
      setPlanStatus(planPath, 'done'),
      setPlanStatus(planPath, 'pending'),
    ];

    // All should complete without error
    await expect(Promise.all(promises)).resolves.toBeDefined();

    // Final state should be one of the statuses
    const finalPlan = await readPlanFile(planPath);
    expect(['pending', 'in_progress', 'done']).toContain(finalPlan.status);
  });
});

describe('Plan File Reading and Writing', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'rmplan-frontmatter-test-')));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should read plan file with YAML front matter correctly', async () => {
    const planPath = join(tempDir, 'front-matter-plan.md');
    const frontMatterContent = `---
id: 100
title: Test Plan with Front Matter
goal: Test the new front matter format
status: pending
priority: high
dependencies: [1, 2]
createdAt: 2024-01-01T00:00:00.000Z
tasks:
  - title: Task 1
    description: First task
    files: []
    steps:
      - prompt: Step 1
        done: false
---

# Implementation Details

This is the markdown body that contains the details of the plan.

## Background

The plan should support:
- Multiple lines of markdown
- Various markdown features
- Code blocks

\`\`\`typescript
const example = "code block";
\`\`\`

And more content here.`;

    await writeFile(planPath, frontMatterContent);

    const plan = await readPlanFile(planPath);

    expect(plan.id).toBe(100);
    expect(plan.title).toBe('Test Plan with Front Matter');
    expect(plan.goal).toBe('Test the new front matter format');
    expect(plan.status).toBe('pending');
    expect(plan.priority).toBe('high');
    expect(plan.dependencies).toEqual([1, 2]);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks![0].title).toBe('Task 1');

    // The markdown body should be placed in the details field
    expect(plan.details).toContain('# Implementation Details');
    expect(plan.details).toContain('This is the markdown body');
    expect(plan.details).toContain('const example = "code block";');
  });

  it('should maintain backward compatibility with pure YAML files', async () => {
    const planPath = join(tempDir, 'legacy-plan.yml');
    const legacyPlan = {
      id: 101,
      title: 'Legacy YAML Plan',
      goal: 'Test backward compatibility',
      details: 'This is the details field in the YAML itself',
      status: 'in_progress',
      priority: 'medium',
      dependencies: [3],
      tasks: [
        {
          title: 'Legacy Task',
          description: 'A task in the old format',
          files: ['src/legacy.ts'],
          steps: [
            { prompt: 'Legacy step 1', done: true },
            { prompt: 'Legacy step 2', done: false },
          ],
        },
      ],
    };

    // Write as pure YAML (old format)
    await writeFile(planPath, yaml.stringify(legacyPlan));

    const plan = await readPlanFile(planPath);

    // Verify all fields are read correctly
    expect(plan.id).toBe(101);
    expect(plan.title).toBe('Legacy YAML Plan');
    expect(plan.goal).toBe('Test backward compatibility');
    expect(plan.details).toBe('This is the details field in the YAML itself');
    expect(plan.status).toBe('in_progress');
    expect(plan.priority).toBe('medium');
    expect(plan.dependencies).toEqual([3]);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks![0].title).toBe('Legacy Task');
    expect(plan.tasks![0].steps).toHaveLength(2);
  });

  it('should write plan file with front matter format when details field is present', async () => {
    const planPath = join(tempDir, 'write-front-matter-plan.md');
    const planToWrite: PlanSchema = {
      id: 102,
      title: 'Test Writing Front Matter',
      goal: 'Test that writePlanFile creates front matter format',
      details: `# Plan Details

This is the markdown content that should be placed
in the body of the file, not in the YAML front matter.

## Features
- Multiple paragraphs
- Lists and formatting
- Code blocks

\`\`\`typescript
const test = "example";
\`\`\``,
      status: 'pending',
      priority: 'high',
      dependencies: [10, 20],
      createdAt: '2024-01-15T00:00:00.000Z',
      updatedAt: '2024-01-15T12:00:00.000Z',
      tasks: [
        {
          title: 'Test Task',
          description: 'A test task',
          files: ['test.ts'],
          done: false,
          steps: [
            { prompt: 'Step 1', done: false },
            { prompt: 'Step 2', done: false },
          ],
        },
      ],
    };

    // Write the plan using writePlanFile
    await writePlanFile(planPath, planToWrite);

    // Read the raw file content to verify format
    const fileContent = await readFile(planPath, 'utf-8');

    // Check that it starts with front matter delimiter
    expect(fileContent.startsWith('---\n')).toBe(true);

    // Check that the yaml-language-server comment is within the front matter
    expect(fileContent).toContain('# yaml-language-server: $schema=');

    // Find where the front matter ends
    const frontMatterEndIndex = fileContent.indexOf('\n---\n', 4);
    expect(frontMatterEndIndex).toBeGreaterThan(0);

    // Extract front matter and body
    const frontMatterSection = fileContent.substring(4, frontMatterEndIndex);
    const bodySection = fileContent.substring(frontMatterEndIndex + 5).trim();

    // Parse the front matter as YAML
    const frontMatterData = yaml.parse(frontMatterSection);

    // Verify the front matter does NOT contain the details field
    expect(frontMatterData.details).toBeUndefined();

    // Verify all other fields are in the front matter
    expect(frontMatterData.id).toBe(102);
    expect(frontMatterData.title).toBe('Test Writing Front Matter');
    expect(frontMatterData.goal).toBe('Test that writePlanFile creates front matter format');
    expect(frontMatterData.status).toBe('pending');
    expect(frontMatterData.priority).toBe('high');
    expect(frontMatterData.dependencies).toEqual([10, 20]);
    expect(frontMatterData.createdAt).toBe('2024-01-15T00:00:00.000Z');
    // updatedAt should be updated when written
    expect(frontMatterData.updatedAt).toBeString();
    expect(frontMatterData.updatedAt).not.toBe('2024-01-15T12:00:00.000Z');
    expect(frontMatterData.tasks).toHaveLength(1);

    // Verify the body contains the original details content
    expect(bodySection).toBe(planToWrite.details);

    // Also verify that readPlanFile can read it back correctly
    const readBackPlan = await readPlanFile(planPath);
    expect(readBackPlan).toEqual({
      ...planToWrite,
      updatedAt: expect.any(String),
      uuid: expect.stringMatching(UUID_REGEX),
    });
  });

  it('should load legacy plans without discoveredFrom without errors', async () => {
    const planPath = join(tempDir, 'legacy-plan.yml');
    const legacyPlan = {
      id: 105,
      title: 'Legacy Plan',
      goal: 'Test backward compatibility',
      details: 'Legacy plan without discoveredFrom field',
      tasks: [],
    };

    await writeFile(planPath, yaml.stringify(legacyPlan));

    const plan = await readPlanFile(planPath);
    expect(plan.discoveredFrom).toBeUndefined();
    expect(plan.id).toBe(105);
  });

  it('should persist discoveredFrom through write and read operations', async () => {
    const planPath = join(tempDir, 'discovered-plan.plan.md');
    const planWithDiscovery: PlanSchema = {
      id: 106,
      title: 'Discovered Plan',
      goal: 'Track discovery lineage',
      details: 'Plan discovered while executing parent plan',
      status: 'pending',
      discoveredFrom: 42,
      tasks: [],
    };

    await writePlanFile(planPath, planWithDiscovery);

    const fileContent = await readFile(planPath, 'utf-8');
    expect(fileContent).toContain('discoveredFrom: 42');

    const readBackPlan = await readPlanFile(planPath);
    expect(readBackPlan.discoveredFrom).toBe(42);
  });

  it('should merge YAML details field with markdown body for backward compatibility', async () => {
    const planPath = join(tempDir, 'backward-compat-plan.md');
    const yamlDetails = 'This is the details content from the YAML front matter.';
    const markdownBody = `# Additional Details

This is additional content in the markdown body.

## More Information
- This content should be appended
- To the YAML details field`;

    const fileContent = `---
id: 103
title: Backward Compatible Plan
goal: Test merging YAML details with markdown body
details: ${yamlDetails}
status: pending
priority: medium
tasks:
  - title: Test Task
    description: A test task
    files: []
    steps:
      - prompt: Step 1
        done: false
---

${markdownBody}`;

    await writeFile(planPath, fileContent);

    const plan = await readPlanFile(planPath);

    // Verify that both the YAML details and markdown body are combined
    expect(plan.id).toBe(103);
    expect(plan.title).toBe('Backward Compatible Plan');
    expect(plan.goal).toBe('Test merging YAML details with markdown body');
    expect(plan.status).toBe('pending');
    expect(plan.priority).toBe('medium');

    // The details field should contain both the YAML value and the markdown body
    expect(plan.details).toBe(`${yamlDetails}\n\n${markdownBody}`);
    expect(plan.details).toContain(yamlDetails);
    expect(plan.details).toContain('# Additional Details');
    expect(plan.details).toContain('This is additional content in the markdown body');
  });

  it('should perform a round-trip test to ensure symmetry between reading and writing', async () => {
    const planPath = join(tempDir, 'round-trip-plan.md');
    const originalPlan: PlanSchema = {
      id: 104,
      title: 'Round Trip Test Plan',
      goal: 'Test that reading and writing preserves data',
      details: `# Round Trip Test

This plan tests the symmetry between readPlanFile and writePlanFile.

## Test Objectives
- Ensure all fields are preserved
- Verify format consistency
- Check that details remain in markdown body

\`\`\`typescript
const roundTrip = "test";
\`\`\``,
      status: 'in_progress',
      priority: 'urgent',
      dependencies: [50, 60, 70],
      createdAt: '2024-02-01T10:00:00.000Z',
      updatedAt: '2024-02-01T15:30:00.000Z',
      tasks: [
        {
          title: 'Validate Round Trip',
          description: 'Ensure data integrity',
          done: false,
          files: ['test1.ts', 'test2.ts'],
          steps: [
            { prompt: 'Write the plan', done: true },
            { prompt: 'Read it back', done: true },
            { prompt: 'Compare results', done: false },
          ],
        },
        {
          title: 'Edge Cases',
          description: 'Test special characters and formatting',
          files: [],
          done: false,
          steps: [{ prompt: 'Test with special chars: " \' \\ /', done: false }],
        },
      ],
    };

    // Write the plan
    await writePlanFile(planPath, originalPlan);

    // Read it back
    const readBackPlan = await readPlanFile(planPath);

    // Assert deep equality
    expect(readBackPlan).toEqual({
      ...originalPlan,
      updatedAt: expect.any(String),
      uuid: expect.stringMatching(UUID_REGEX),
    });

    // Specifically check that complex fields are preserved
    expect(readBackPlan.tasks).toHaveLength(2);
    expect(readBackPlan.tasks![0].steps).toHaveLength(3);
    expect(readBackPlan.tasks![1].title).toBe('Edge Cases');
    expect(readBackPlan.dependencies).toEqual([50, 60, 70]);
    expect(readBackPlan.details).toContain('const roundTrip = "test";');
  });

  it('should verify the migration path for old-format files', async () => {
    const oldFormatPath = join(tempDir, 'old-format-plan.yml');
    const newFormatPath = join(tempDir, 'migrated-plan.md');

    // Create a pure YAML plan file (old format)
    const oldFormatPlan = {
      id: 105,
      title: 'Old Format Plan for Migration',
      goal: 'Test migration from old to new format',
      details: `This is the old format where details are stored in YAML.

It should be migrated to the new format with:
- YAML front matter for metadata
- Markdown body for details content

The migration should preserve all data.`,
      status: 'pending',
      priority: 'high',
      dependencies: [80, 90],
      createdAt: '2024-01-20T08:00:00.000Z',
      updatedAt: '2024-01-20T08:00:00.000Z',
      tasks: [
        {
          title: 'Migration Task',
          description: 'Task to test migration',
          files: ['migrate.ts'],
          steps: [
            { prompt: 'Read old format', done: false },
            { prompt: 'Write new format', done: false },
          ],
        },
      ],
    };

    // Write the old format file
    await writeFile(oldFormatPath, yaml.stringify(oldFormatPlan));

    // Read the old format file
    const readPlan = await readPlanFile(oldFormatPath);

    // Write it back in the new format
    await writePlanFile(newFormatPath, readPlan);

    // Read the raw content of the new file to verify format
    const newFileContent = await readFile(newFormatPath, 'utf-8');

    // Verify it's in front matter format
    expect(newFileContent.startsWith('---\n')).toBe(true);

    // Find the front matter and body sections
    const frontMatterEndIndex = newFileContent.indexOf('\n---\n', 4);
    expect(frontMatterEndIndex).toBeGreaterThan(0);

    const frontMatterSection = newFileContent.substring(4, frontMatterEndIndex);
    const bodySection = newFileContent.substring(frontMatterEndIndex + 5).trim();

    // Parse the front matter
    const frontMatterData = yaml.parse(frontMatterSection);

    // Verify the front matter does NOT contain details
    expect(frontMatterData.details).toBeUndefined();

    // Verify all other fields are in front matter
    expect(frontMatterData.id).toBe(105);
    expect(frontMatterData.title).toBe('Old Format Plan for Migration');
    expect(frontMatterData.goal).toBe('Test migration from old to new format');
    expect(frontMatterData.status).toBe('pending');
    expect(frontMatterData.priority).toBe('high');
    expect(frontMatterData.dependencies).toEqual([80, 90]);
    expect(frontMatterData.tasks).toHaveLength(1);

    // Verify the body contains the original details
    expect(bodySection).toBe(oldFormatPlan.details);

    // Finally, read the new file and ensure data integrity
    const migratedPlan = await readPlanFile(newFormatPath);
    expect(migratedPlan).toMatchObject({ ...readPlan, updatedAt: expect.any(String) });
  });

  it('should preserve task done flag when writing and reading plans', async () => {
    const planPath = join(tempDir, 'task-done-flag-plan.md');
    const planWithTaskDone: PlanSchema = {
      id: 107,
      title: 'Plan with Task Done Flag',
      goal: 'Test that task done flag is preserved',
      details: `# Task Done Flag Test
      
This plan tests that the done flag on tasks is properly preserved
when writing and reading plan files.`,
      status: 'in_progress',
      priority: 'medium',
      tasks: [
        {
          title: 'Completed Task',
          description: 'This task has been completed',
          files: ['src/completed.ts'],
          done: true,
          steps: [
            { prompt: 'Step 1', done: true },
            { prompt: 'Step 2', done: true },
          ],
        },
        {
          title: 'Pending Task',
          description: 'This task is not done yet',
          files: ['src/pending.ts'],
          done: false,
          steps: [{ prompt: 'Step 1', done: false }],
        },
        {
          title: 'Task without done flag',
          description: 'This task has no explicit done flag',
          files: [],
          steps: [],
        },
      ],
    };

    // Write the plan
    await writePlanFile(planPath, planWithTaskDone);

    // Read it back
    const readBackPlan = await readPlanFile(planPath);

    // Verify all fields are preserved, especially the done flags
    expect(readBackPlan.id).toBe(107);
    expect(readBackPlan.tasks).toHaveLength(3);

    // Check first task (done: true)
    expect(readBackPlan.tasks![0].title).toBe('Completed Task');
    expect(readBackPlan.tasks![0].done).toBe(true);
    expect(readBackPlan.tasks![0].steps).toHaveLength(2);

    // Check second task (done: false)
    expect(readBackPlan.tasks![1].title).toBe('Pending Task');
    expect(readBackPlan.tasks![1].done).toBe(false);

    // Check third task (no explicit done flag, defaults to false when not set)
    expect(readBackPlan.tasks![2].title).toBe('Task without done flag');
    expect(readBackPlan.tasks![2].done).toBe(false);
  });

  it('should handle backward-compatibility merge-and-write scenario', async () => {
    const mixedFormatPath = join(tempDir, 'mixed-format-plan.md');
    const rewrittenPath = join(tempDir, 'rewritten-plan.md');

    const yamlDetails = 'These are the details from the YAML front matter section.';
    const markdownBody = `# Additional Markdown Content

This content is in the markdown body and should be merged with the YAML details.

## Important Notes
- Both sources of details should be preserved
- The order should be: YAML details first, then markdown body
- After rewriting, only the markdown body should contain the details`;

    // Create a file with details in both front matter and body
    const mixedContent = `---
id: 106
title: Mixed Format Plan
goal: Test merging and rewriting details from both sources
details: ${yamlDetails}
status: in_progress
priority: low
dependencies: [100]
createdAt: 2024-03-01T00:00:00.000Z
tasks:
  - title: Merge Test Task
    description: Testing the merge behavior
    files: ['merge.ts', 'test.ts']
    steps:
      - prompt: Read mixed format
        done: true
      - prompt: Merge details
        done: false
---

${markdownBody}`;

    await writeFile(mixedFormatPath, mixedContent);

    // Read the mixed format file (should merge details)
    const mergedPlan = await readPlanFile(mixedFormatPath);

    // Verify the details were merged correctly
    expect(mergedPlan.details).toBe(`${yamlDetails}\n\n${markdownBody}`);
    expect(mergedPlan.details).toContain(yamlDetails);
    expect(mergedPlan.details).toContain(markdownBody);

    // Write it back to a new file
    await writePlanFile(rewrittenPath, mergedPlan);

    // Read the raw content of the rewritten file
    const rewrittenContent = await readFile(rewrittenPath, 'utf-8');

    // Verify it's in the standard front matter format
    expect(rewrittenContent.startsWith('---\n')).toBe(true);

    // Extract front matter and body
    const fmEndIndex = rewrittenContent.indexOf('\n---\n', 4);
    const rewrittenFrontMatter = rewrittenContent.substring(4, fmEndIndex);
    const rewrittenBody = rewrittenContent.substring(fmEndIndex + 5).trim();

    // Parse the front matter
    const rewrittenFmData = yaml.parse(rewrittenFrontMatter);

    // Verify NO details in the front matter
    expect(rewrittenFmData.details).toBeUndefined();

    // Verify the body contains the combined details
    expect(rewrittenBody).toBe(`${yamlDetails}\n\n${markdownBody}`);

    // Verify all other fields are preserved correctly
    expect(rewrittenFmData.id).toBe(106);
    expect(rewrittenFmData.title).toBe('Mixed Format Plan');
    expect(rewrittenFmData.goal).toBe('Test merging and rewriting details from both sources');
    expect(rewrittenFmData.status).toBe('in_progress');
    expect(rewrittenFmData.priority).toBe('low');
    expect(rewrittenFmData.dependencies).toEqual([100]);
    expect(rewrittenFmData.tasks).toHaveLength(1);
    expect(rewrittenFmData.tasks[0].files).toEqual(['merge.ts', 'test.ts']);

    // Final verification: read the rewritten file and check data integrity
    const finalPlan = await readPlanFile(rewrittenPath);
    expect(finalPlan).toMatchObject({ ...mergedPlan, updatedAt: expect.any(String) });
  });
});

describe('schema validation and YAML serialization', () => {
  it('should serialize numeric IDs as numbers in YAML', () => {
    const planWithNumericId: PlanSchema = {
      id: 123,
      title: 'Test Plan with Numeric ID',
      goal: 'Test numeric ID serialization',
      details: 'This plan has a numeric ID',
      status: 'pending',
      tasks: [],
    };

    const yamlString = yaml.stringify(planWithNumericId);

    // Verify the YAML contains the number, not a string
    expect(yamlString).toContain('id: 123');
    expect(yamlString).not.toContain('id: "123"');
    expect(yamlString).not.toContain("id: '123'");
  });

  it('should parse numeric IDs from YAML as numbers', () => {
    const yamlWithNumericId = `
id: 456
title: Test Plan
goal: Test parsing
details: Test details
tasks: []
`;

    const parsed = yaml.parse(yamlWithNumericId);
    const validatedPlan = planSchema.parse(parsed);

    expect(validatedPlan.id).toBe(456);
    expect(typeof validatedPlan.id).toBe('number');
  });

  it('should accept plans without IDs', () => {
    const planWithoutId: PlanSchema = {
      title: 'Test Plan without ID',
      goal: 'Test optional ID',
      details: 'This plan has no ID',
      status: 'pending',
      tasks: [],
    };

    const yamlString = yaml.stringify(planWithoutId);

    // Verify the YAML doesn't contain an ID field
    expect(yamlString).not.toContain('id:');

    // Parse it back and verify
    const parsed = yaml.parse(yamlString);
    const validatedPlan = planSchema.parse(parsed);

    expect(validatedPlan.id).toBeUndefined();
  });

  it('should reject invalid numeric IDs', () => {
    const invalidNumericIds = [
      { id: 0, title: 'Zero ID', goal: 'Test', details: 'Test', tasks: [] },
      { id: -5, title: 'Negative ID', goal: 'Test', details: 'Test', tasks: [] },
      { id: 1.5, title: 'Float ID', goal: 'Test', details: 'Test', tasks: [] },
    ];

    for (const invalidPlan of invalidNumericIds) {
      expect(() => planSchema.parse(invalidPlan)).toThrow();
    }
  });

  it('should handle mixed ID types in a plan collection', () => {
    const plans = [
      { id: 100, title: 'Numeric ID Plan', goal: 'Test', details: 'Test', tasks: [] },
      { title: 'No ID Plan', goal: 'Test', details: 'Test', tasks: [] },
    ];

    // All should be valid
    for (const plan of plans) {
      expect(() => planSchema.parse(plan)).not.toThrow();
    }
  });

  it('should accept valid discoveredFrom values', () => {
    const plan = {
      id: 200,
      title: 'Discovered Plan',
      goal: 'Test discoveredFrom',
      details: 'Testing discoveredFrom support',
      tasks: [],
      discoveredFrom: 42,
    };

    const parsed = planSchema.parse(plan);
    expect(parsed.discoveredFrom).toBe(42);
  });

  it('should reject invalid discoveredFrom values', () => {
    const basePlan = {
      id: 201,
      title: 'Invalid Discovered Plan',
      goal: 'Invalid discoveredFrom',
      details: 'Testing invalid discoveredFrom',
      tasks: [],
    };

    const invalidValues = [-1, 0, 1.5, 'not-a-number'];

    for (const value of invalidValues) {
      expect(() => planSchema.parse({ ...basePlan, discoveredFrom: value })).toThrow();
    }
  });

  it('should treat discoveredFrom as optional', () => {
    const plan = {
      id: 202,
      title: 'Optional discoveredFrom Plan',
      goal: 'Optional field test',
      details: 'Testing optional discoveredFrom',
      tasks: [],
    };

    const parsed = planSchema.parse(plan);
    expect(parsed.discoveredFrom).toBeUndefined();
  });
});
