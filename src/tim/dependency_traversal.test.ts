import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { clearPlanCache, writePlanFile, readAllPlans } from './plans.js';
import { traversePlanDependencies, getDirectDependencies } from './dependency_traversal.js';
import type { PlanSchema } from './planSchema.js';

describe('Dependency Traversal', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-dep-traversal-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('getDirectDependencies', () => {
    test('returns empty array for non-existent plan', async () => {
      const { plans } = await readAllPlans(tasksDir);
      const deps = getDirectDependencies(999, plans);
      expect(deps).toEqual([]);
    });

    test('finds explicit dependencies from dependencies array', async () => {
      const plan: PlanSchema = {
        id: 1,
        title: 'Main Plan',
        goal: 'Main goal',
        details: 'Main details',
        status: 'in_progress',
        dependencies: [2, 3],
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), plan);

      const dep1: PlanSchema = {
        id: 2,
        title: 'Dependency 1',
        goal: 'Dep 1 goal',
        details: 'Dep 1 details',
        status: 'pending',
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), dep1);

      const dep2: PlanSchema = {
        id: 3,
        title: 'Dependency 2',
        goal: 'Dep 2 goal',
        details: 'Dep 2 details',
        status: 'pending',
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '3.yaml'), dep2);

      const { plans } = await readAllPlans(tasksDir);
      const deps = getDirectDependencies(1, plans);
      expect(deps.sort()).toEqual([2, 3]);
    });

    test('finds child plans with parent field', async () => {
      const parent: PlanSchema = {
        id: 1,
        title: 'Parent Plan',
        goal: 'Parent goal',
        details: 'Parent details',
        status: 'in_progress',
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), parent);

      const child1: PlanSchema = {
        id: 2,
        title: 'Child 1',
        goal: 'Child 1 goal',
        details: 'Child 1 details',
        status: 'pending',
        parent: 1,
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), child1);

      const child2: PlanSchema = {
        id: 3,
        title: 'Child 2',
        goal: 'Child 2 goal',
        details: 'Child 2 details',
        status: 'pending',
        parent: 1,
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '3.yaml'), child2);

      const { plans } = await readAllPlans(tasksDir);
      const deps = getDirectDependencies(1, plans);
      expect(deps.sort()).toEqual([2, 3]);
    });

    test('finds both explicit dependencies and children', async () => {
      const parent: PlanSchema = {
        id: 1,
        title: 'Parent Plan',
        goal: 'Parent goal',
        details: 'Parent details',
        status: 'in_progress',
        dependencies: [4],
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), parent);

      const child1: PlanSchema = {
        id: 2,
        title: 'Child 1',
        goal: 'Child 1 goal',
        details: 'Child 1 details',
        status: 'pending',
        parent: 1,
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), child1);

      const child2: PlanSchema = {
        id: 3,
        title: 'Child 2',
        goal: 'Child 2 goal',
        details: 'Child 2 details',
        status: 'pending',
        parent: 1,
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '3.yaml'), child2);

      const dep: PlanSchema = {
        id: 4,
        title: 'Dependency',
        goal: 'Dep goal',
        details: 'Dep details',
        status: 'pending',
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '4.yaml'), dep);

      const { plans } = await readAllPlans(tasksDir);
      const deps = getDirectDependencies(1, plans);
      expect(deps.sort()).toEqual([2, 3, 4]);
    });
  });

  describe('traversePlanDependencies', () => {
    test('returns null for non-existent directory', async () => {
      const result = await traversePlanDependencies(1, '/non/existent/directory');
      expect(result.planId).toBeNull();
      expect(result.message).toContain('Directory not found');
    });

    test('returns null for non-existent plan', async () => {
      const result = await traversePlanDependencies(999, tasksDir);
      expect(result.planId).toBeNull();
      expect(result.message).toContain('Plan not found');
    });

    test('finds simple direct dependency', async () => {
      const parent: PlanSchema = {
        id: 1,
        title: 'Parent Plan',
        goal: 'Parent goal',
        details: 'Parent details',
        status: 'in_progress',
        dependencies: [2],
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), parent);

      const dep: PlanSchema = {
        id: 2,
        title: 'Dependency',
        goal: 'Dep goal',
        details: 'Dep details',
        status: 'pending',
        tasks: [{ title: 'Task', description: 'Do something', files: [] }],
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), dep);

      const result = await traversePlanDependencies(1, tasksDir);
      expect(result.planId).toBe(2);
    });

    test('finds child plan that is ready', async () => {
      const parent: PlanSchema = {
        id: 1,
        title: 'Parent Plan',
        goal: 'Parent goal',
        details: 'Parent details',
        status: 'in_progress',
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), parent);

      const child: PlanSchema = {
        id: 2,
        title: 'Child',
        goal: 'Child goal',
        details: 'Child details',
        status: 'pending',
        parent: 1,
        tasks: [{ title: 'Task', description: 'Do something', files: [] }],
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), child);

      const result = await traversePlanDependencies(1, tasksDir);
      expect(result.planId).toBe(2);
    });

    test('skips completed dependencies', async () => {
      const parent: PlanSchema = {
        id: 1,
        title: 'Parent Plan',
        goal: 'Parent goal',
        details: 'Parent details',
        status: 'in_progress',
        dependencies: [2, 3],
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), parent);

      const dep1: PlanSchema = {
        id: 2,
        title: 'Dependency 1',
        goal: 'Dep 1 goal',
        details: 'Dep 1 details',
        status: 'done',
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), dep1);

      const dep2: PlanSchema = {
        id: 3,
        title: 'Dependency 2',
        goal: 'Dep 2 goal',
        details: 'Dep 2 details',
        status: 'pending',
        tasks: [{ title: 'Task', description: 'Do something', files: [] }],
      };
      await writePlanFile(path.join(tasksDir, '3.yaml'), dep2);

      const result = await traversePlanDependencies(1, tasksDir);
      expect(result.planId).toBe(3);
    });

    test('finds nested dependencies using BFS', async () => {
      const grandparent: PlanSchema = {
        id: 1,
        title: 'Grandparent',
        goal: 'Grandparent goal',
        details: 'Grandparent details',
        status: 'in_progress',
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), grandparent);

      const parent: PlanSchema = {
        id: 2,
        title: 'Parent',
        goal: 'Parent goal',
        details: 'Parent details',
        status: 'done',
        parent: 1,
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), parent);

      const child: PlanSchema = {
        id: 3,
        title: 'Child',
        goal: 'Child goal',
        details: 'Child details',
        status: 'pending',
        parent: 2,
        tasks: [{ title: 'Task', description: 'Do something', files: [] }],
      };
      await writePlanFile(path.join(tasksDir, '3.yaml'), child);

      const result = await traversePlanDependencies(1, tasksDir);
      expect(result.planId).toBe(3);
    });

    test('handles circular dependencies', async () => {
      const plan1: PlanSchema = {
        id: 1,
        title: 'Plan 1',
        goal: 'Plan 1 goal',
        details: 'Plan 1 details',
        status: 'in_progress',
        dependencies: [2],
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), plan1);

      const plan2: PlanSchema = {
        id: 2,
        title: 'Plan 2',
        goal: 'Plan 2 goal',
        details: 'Plan 2 details',
        status: 'done', // Change to done so no in_progress plans are found
        dependencies: [3],
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), plan2);

      const plan3: PlanSchema = {
        id: 3,
        title: 'Plan 3',
        goal: 'Plan 3 goal',
        details: 'Plan 3 details',
        status: 'done', // Change to done
        dependencies: [1], // Circular dependency back to plan 1
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '3.yaml'), plan3);

      // Should not infinite loop and should return no ready dependencies
      const result = await traversePlanDependencies(1, tasksDir);
      expect(result.planId).toBeNull();
      expect(result.message).toContain('No ready or pending dependencies found');
    });

    test('returns null for plan with no dependencies', async () => {
      const plan: PlanSchema = {
        id: 1,
        title: 'Standalone Plan',
        goal: 'Standalone goal',
        details: 'Standalone details',
        status: 'in_progress',
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), plan);

      const result = await traversePlanDependencies(1, tasksDir);
      expect(result.planId).toBeNull();
      expect(result.message).toContain('No ready or pending dependencies found');
    });

    test('checks dependency readiness for pending plans', async () => {
      const parent: PlanSchema = {
        id: 1,
        title: 'Parent',
        goal: 'Parent goal',
        details: 'Parent details',
        status: 'in_progress',
        dependencies: [2],
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), parent);

      const dep: PlanSchema = {
        id: 2,
        title: 'Dependency with deps',
        goal: 'Dep goal',
        details: 'Dep details',
        status: 'pending',
        dependencies: [3],
        tasks: [{ title: 'Task', description: 'Do something', files: [] }],
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), dep);

      const subdep: PlanSchema = {
        id: 3,
        title: 'Sub-dependency',
        goal: 'Subdep goal',
        details: 'Subdep details',
        status: 'pending', // Not done, so dep 2 is not ready
        tasks: [{ title: 'Task', description: 'Do something', files: [] }],
      };
      await writePlanFile(path.join(tasksDir, '3.yaml'), subdep);

      const result = await traversePlanDependencies(1, tasksDir);
      // Should find subdep 3 as it's the first ready plan
      expect(result.planId).toBe(3);
    });

    test('finds in_progress plans immediately', async () => {
      const parent: PlanSchema = {
        id: 1,
        title: 'Parent',
        goal: 'Parent goal',
        details: 'Parent details',
        status: 'in_progress',
        dependencies: [2],
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), parent);

      const dep: PlanSchema = {
        id: 2,
        title: 'In Progress Dependency',
        goal: 'Dep goal',
        details: 'Dep details',
        status: 'in_progress',
        dependencies: [3], // Has dependencies but doesn't matter since it's in_progress
        tasks: [{ title: 'Task', description: 'Do something', files: [] }],
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), dep);

      const subdep: PlanSchema = {
        id: 3,
        title: 'Sub-dependency',
        goal: 'Subdep goal',
        details: 'Subdep details',
        status: 'pending',
        tasks: [{ title: 'Task', description: 'Do something', files: [] }],
      };
      await writePlanFile(path.join(tasksDir, '3.yaml'), subdep);

      const result = await traversePlanDependencies(1, tasksDir);
      // Should find dep 2 as it's in_progress (ready immediately)
      expect(result.planId).toBe(2);
    });

    test('handles mixed dependencies and children', async () => {
      const parent: PlanSchema = {
        id: 1,
        title: 'Parent',
        goal: 'Parent goal',
        details: 'Parent details',
        status: 'in_progress',
        dependencies: [4],
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), parent);

      const child1: PlanSchema = {
        id: 2,
        title: 'Child 1',
        goal: 'Child 1 goal',
        details: 'Child 1 details',
        status: 'done',
        parent: 1,
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), child1);

      const child2: PlanSchema = {
        id: 3,
        title: 'Child 2',
        goal: 'Child 2 goal',
        details: 'Child 2 details',
        status: 'pending',
        parent: 1,
        tasks: [{ title: 'Task', description: 'Do something', files: [] }],
      };
      await writePlanFile(path.join(tasksDir, '3.yaml'), child2);

      const dep: PlanSchema = {
        id: 4,
        title: 'Dependency',
        goal: 'Dep goal',
        details: 'Dep details',
        status: 'done',
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '4.yaml'), dep);

      const result = await traversePlanDependencies(1, tasksDir);
      // Should find child 3 as it's the only pending plan
      expect(result.planId).toBe(3);
    });

    test('finds first ready dependency when multiple are at same BFS level', async () => {
      const parent: PlanSchema = {
        id: 1,
        title: 'Parent',
        goal: 'Parent goal',
        details: 'Parent details',
        status: 'in_progress',
        dependencies: [2, 3, 4],
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), parent);

      const dep1: PlanSchema = {
        id: 2,
        title: 'Dependency 1',
        goal: 'Dep 1 goal',
        details: 'Dep 1 details',
        status: 'done',
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), dep1);

      const dep2: PlanSchema = {
        id: 3,
        title: 'Dependency 2',
        goal: 'Dep 2 goal',
        details: 'Dep 2 details',
        status: 'pending',
        tasks: [{ title: 'Task', description: 'Do something', files: [] }],
      };
      await writePlanFile(path.join(tasksDir, '3.yaml'), dep2);

      const dep3: PlanSchema = {
        id: 4,
        title: 'Dependency 3',
        goal: 'Dep 3 goal',
        details: 'Dep 3 details',
        status: 'pending',
        tasks: [{ title: 'Task', description: 'Do something else', files: [] }],
      };
      await writePlanFile(path.join(tasksDir, '4.yaml'), dep3);

      const result = await traversePlanDependencies(1, tasksDir);
      // Should find dep 3 as it's the first pending plan encountered in BFS order
      expect(result.planId).toBe(3);
    });

    test('handles empty dependencies array same as no dependencies', async () => {
      const plan1: PlanSchema = {
        id: 1,
        title: 'Plan with empty deps',
        goal: 'Goal',
        details: 'Details',
        status: 'in_progress',
        dependencies: [],
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), plan1);

      const plan2: PlanSchema = {
        id: 2,
        title: 'Plan with no deps field',
        goal: 'Goal',
        details: 'Details',
        status: 'in_progress',
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), plan2);

      const result1 = await traversePlanDependencies(1, tasksDir);
      expect(result1.planId).toBeNull();
      expect(result1.message).toContain('No ready or pending dependencies found');

      const result2 = await traversePlanDependencies(2, tasksDir);
      expect(result2.planId).toBeNull();
      expect(result2.message).toContain('No ready or pending dependencies found');
    });

    test('ignores self-referential dependencies', async () => {
      const plan: PlanSchema = {
        id: 1,
        title: 'Self-referential plan',
        goal: 'Goal',
        details: 'Details',
        status: 'in_progress',
        dependencies: [1, 2], // Includes itself
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), plan);

      const dep: PlanSchema = {
        id: 2,
        title: 'Normal dependency',
        goal: 'Dep goal',
        details: 'Dep details',
        status: 'pending',
        tasks: [{ title: 'Task', description: 'Do something', files: [] }],
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), dep);

      const result = await traversePlanDependencies(1, tasksDir);
      // Should find dep 2, ignoring the self-reference
      expect(result.planId).toBe(2);
    });

    test('handles deeply nested parent-child relationships', async () => {
      // Create a chain: 1 -> 2 -> 3 -> 4 -> 5 (using parent relationships)
      const plans: PlanSchema[] = [
        {
          id: 1,
          title: 'Level 1',
          goal: 'Goal 1',
          details: 'Details 1',
          status: 'in_progress',
          tasks: [],
        },
        {
          id: 2,
          title: 'Level 2',
          goal: 'Goal 2',
          details: 'Details 2',
          status: 'done',
          parent: 1,
          tasks: [],
        },
        {
          id: 3,
          title: 'Level 3',
          goal: 'Goal 3',
          details: 'Details 3',
          status: 'done',
          parent: 2,
          tasks: [],
        },
        {
          id: 4,
          title: 'Level 4',
          goal: 'Goal 4',
          details: 'Details 4',
          status: 'done',
          parent: 3,
          tasks: [],
        },
        {
          id: 5,
          title: 'Level 5',
          goal: 'Goal 5',
          details: 'Details 5',
          status: 'pending',
          parent: 4,
          tasks: [{ title: 'Deep task', description: 'Do something deep', files: [] }],
        },
      ];

      for (const plan of plans) {
        await writePlanFile(path.join(tasksDir, `${plan.id}.yaml`), plan);
      }

      const result = await traversePlanDependencies(1, tasksDir);
      // Should find plan 5 through the parent-child chain
      expect(result.planId).toBe(5);
    });

    test('pending plan with all dependencies done is ready', async () => {
      const parent: PlanSchema = {
        id: 1,
        title: 'Parent',
        goal: 'Parent goal',
        details: 'Parent details',
        status: 'in_progress',
        dependencies: [2],
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), parent);

      const dep: PlanSchema = {
        id: 2,
        title: 'Dependency with deps',
        goal: 'Dep goal',
        details: 'Dep details',
        status: 'pending',
        dependencies: [3, 4],
        tasks: [{ title: 'Task', description: 'Do something', files: [] }],
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), dep);

      const subdep1: PlanSchema = {
        id: 3,
        title: 'Sub-dependency 1',
        goal: 'Subdep 1 goal',
        details: 'Subdep 1 details',
        status: 'done',
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '3.yaml'), subdep1);

      const subdep2: PlanSchema = {
        id: 4,
        title: 'Sub-dependency 2',
        goal: 'Subdep 2 goal',
        details: 'Subdep 2 details',
        status: 'done',
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '4.yaml'), subdep2);

      const result = await traversePlanDependencies(1, tasksDir);
      // Should find dep 2 as all its dependencies are done
      expect(result.planId).toBe(2);
    });

    test('skips pending plans with no tasks', async () => {
      const parent: PlanSchema = {
        id: 1,
        title: 'Parent',
        goal: 'Parent goal',
        details: 'Parent details',
        status: 'in_progress',
        dependencies: [2],
        tasks: [],
      };
      await writePlanFile(path.join(tasksDir, '1.yaml'), parent);

      // This plan is pending but has no tasks - should be skipped
      const dep: PlanSchema = {
        id: 2,
        title: 'Pending plan with no tasks',
        goal: 'Dep goal',
        details: 'Dep details',
        status: 'pending',
        dependencies: [3],
        tasks: [], // No tasks!
      };
      await writePlanFile(path.join(tasksDir, '2.yaml'), dep);

      const subdep: PlanSchema = {
        id: 3,
        title: 'Sub-dependency',
        goal: 'Subdep goal',
        details: 'Subdep details',
        status: 'pending',
        tasks: [{ title: 'Task', description: 'Do something', files: [] }],
      };
      await writePlanFile(path.join(tasksDir, '3.yaml'), subdep);

      const result = await traversePlanDependencies(1, tasksDir);
      // Should skip dep 2 (no tasks) and find subdep 3
      expect(result.planId).toBe(3);
    });
  });
});
