import { describe, it, expect } from 'bun:test';
import {
  getParentChain,
  getAllChildren,
  getCompletedChildren,
  getDirectChildren,
  getPendingChildren,
  hasCycleInParentChain,
  getRootPlans,
  type PlanWithFilename,
} from './hierarchy.js';

// Helper function to create a plan for testing
function createPlan(
  id: number,
  title: string,
  status: 'pending' | 'in_progress' | 'done' | 'cancelled' = 'pending',
  parent?: number
): PlanWithFilename {
  return {
    id,
    title,
    status,
    parent,
    goal: `Goal for ${title}`,
    tasks: [],
    filename: `plan-${id}.yml`,
  };
}

describe('Hierarchy Utilities', () => {
  describe('getParentChain', () => {
    it('should return empty array for plan with no parent', () => {
      const plan = createPlan(1, 'Root Plan');
      const allPlans = new Map([[1, plan]]);

      const parents = getParentChain(plan, allPlans);
      expect(parents).toEqual([]);
    });

    it('should return single parent for simple parent-child relationship', () => {
      const parent = createPlan(1, 'Parent Plan');
      const child = createPlan(2, 'Child Plan', 'pending', 1);
      const allPlans = new Map([
        [1, parent],
        [2, child],
      ]);

      const parents = getParentChain(child, allPlans);
      expect(parents).toEqual([parent]);
    });

    it('should return multi-level hierarchy (grandparent, great-grandparent)', () => {
      const greatGrandparent = createPlan(1, 'Great-Grandparent');
      const grandparent = createPlan(2, 'Grandparent', 'pending', 1);
      const parent = createPlan(3, 'Parent', 'pending', 2);
      const child = createPlan(4, 'Child', 'pending', 3);
      const allPlans = new Map([
        [1, greatGrandparent],
        [2, grandparent],
        [3, parent],
        [4, child],
      ]);

      const parents = getParentChain(child, allPlans);
      expect(parents).toEqual([parent, grandparent, greatGrandparent]);
    });

    it('should handle missing parent reference gracefully', () => {
      const child = createPlan(2, 'Child Plan', 'pending', 1); // parent ID 1 doesn't exist
      const allPlans = new Map([[2, child]]);

      const parents = getParentChain(child, allPlans);
      expect(parents).toEqual([]);
    });

    it('should detect and break cycles in parent chain', () => {
      // Create a cycle: 1 -> 2 -> 3 -> 1
      const plan1 = createPlan(1, 'Plan 1', 'pending', 3);
      const plan2 = createPlan(2, 'Plan 2', 'pending', 1);
      const plan3 = createPlan(3, 'Plan 3', 'pending', 2);
      const allPlans = new Map([
        [1, plan1],
        [2, plan2],
        [3, plan3],
      ]);

      const parents = getParentChain(plan1, allPlans);
      // Should stop when cycle is detected
      expect(parents.length).toBeLessThanOrEqual(3);
      expect(parents).toContain(plan3);
      expect(parents).toContain(plan2);
    });
  });

  describe('getDirectChildren', () => {
    it('should return empty array for plan with no children', () => {
      const plan = createPlan(1, 'Plan with no children');
      const allPlans = new Map([[1, plan]]);

      const children = getDirectChildren(1, allPlans);
      expect(children).toEqual([]);
    });

    it('should return direct children only (not grandchildren)', () => {
      const parent = createPlan(1, 'Parent');
      const child1 = createPlan(2, 'Child 1', 'pending', 1);
      const child2 = createPlan(3, 'Child 2', 'pending', 1);
      const grandchild = createPlan(4, 'Grandchild', 'pending', 2);
      const allPlans = new Map([
        [1, parent],
        [2, child1],
        [3, child2],
        [4, grandchild],
      ]);

      const children = getDirectChildren(1, allPlans);
      expect(children).toHaveLength(2);
      expect(children).toContain(child1);
      expect(children).toContain(child2);
      expect(children).not.toContain(grandchild);
    });

    it('should return children sorted by ID', () => {
      const parent = createPlan(1, 'Parent');
      const child3 = createPlan(5, 'Child 3', 'pending', 1);
      const child1 = createPlan(2, 'Child 1', 'pending', 1);
      const child2 = createPlan(3, 'Child 2', 'pending', 1);
      const allPlans = new Map([
        [1, parent],
        [2, child1],
        [3, child2],
        [5, child3],
      ]);

      const children = getDirectChildren(1, allPlans);
      expect(children.map((c) => c.id)).toEqual([2, 3, 5]);
    });
  });

  describe('getAllChildren', () => {
    it('should return empty array for plan with no children', () => {
      const plan = createPlan(1, 'Plan with no children');
      const allPlans = new Map([[1, plan]]);

      const children = getAllChildren(1, allPlans);
      expect(children).toEqual([]);
    });

    it('should return all descendants recursively', () => {
      const parent = createPlan(1, 'Parent');
      const child1 = createPlan(2, 'Child 1', 'pending', 1);
      const child2 = createPlan(3, 'Child 2', 'pending', 1);
      const grandchild1 = createPlan(4, 'Grandchild 1', 'pending', 2);
      const grandchild2 = createPlan(5, 'Grandchild 2', 'pending', 3);
      const greatGrandchild = createPlan(6, 'Great-Grandchild', 'pending', 4);
      const allPlans = new Map([
        [1, parent],
        [2, child1],
        [3, child2],
        [4, grandchild1],
        [5, grandchild2],
        [6, greatGrandchild],
      ]);

      const children = getAllChildren(1, allPlans);
      expect(children).toHaveLength(5);
      expect(children).toContain(child1);
      expect(children).toContain(child2);
      expect(children).toContain(grandchild1);
      expect(children).toContain(grandchild2);
      expect(children).toContain(greatGrandchild);
    });

    it('should handle cycles in child relationships without infinite loop', () => {
      // Create a normal hierarchy: 1 -> 2 -> 3 -> 4, plus 1 -> 5
      const parent = createPlan(1, 'Parent');
      const child1 = createPlan(2, 'Child 1', 'pending', 1);
      const child2 = createPlan(3, 'Child 2', 'pending', 2);
      const child3 = createPlan(4, 'Child 3', 'pending', 3);
      const child4 = createPlan(5, 'Child 4', 'pending', 1); // Another direct child of 1

      // Now create a cycle by making child1 (plan 2) also a child of child2 (plan 3)
      // This creates: 1 -> 2, 1 -> 5, 2 -> 3, 3 -> 4, and 3 -> 2 (cycle)
      const cyclicChild = createPlan(6, 'Cyclic Child', 'pending', 3);
      cyclicChild.id = 2; // Make it the same as child1 to create cycle

      const allPlans = new Map([
        [1, parent],
        [2, child1], // parent: 1
        [3, child2], // parent: 2
        [4, child3], // parent: 3
        [5, child4], // parent: 1
      ]);

      // Manually add another relationship that creates a cycle
      // Add plan 2 as also having parent 3 (creating a cycle 2 -> 3 -> 2)
      const allPlansWithCycle = new Map(allPlans);

      // Simulate multiple children pointing to each other
      // Plan 7 is child of 3, and plan 3 is child of 7 (cycle)
      const plan7 = createPlan(7, 'Plan 7', 'pending', 3);
      const modifiedPlan3 = { ...child2, parent: 7 }; // Make 3 child of 7

      allPlansWithCycle.set(3, modifiedPlan3);
      allPlansWithCycle.set(7, plan7);

      const children = getAllChildren(1, allPlansWithCycle);
      // Should include child1 (plan 2) but handle the cycle between 3 and 7
      // The function should not hang and should return some reasonable result
      expect(children.length).toBeGreaterThanOrEqual(1);
      expect(children.some((c) => c.id === 2)).toBe(true);
    });

    it('should return results sorted by ID', () => {
      const parent = createPlan(1, 'Parent');
      const child1 = createPlan(5, 'Child 1', 'pending', 1);
      const child2 = createPlan(2, 'Child 2', 'pending', 1);
      const grandchild = createPlan(3, 'Grandchild', 'pending', 5);
      const allPlans = new Map([
        [1, parent],
        [2, child2],
        [3, grandchild],
        [5, child1],
      ]);

      const children = getAllChildren(1, allPlans);
      expect(children.map((c) => c.id)).toEqual([2, 3, 5]);
    });
  });

  describe('getCompletedChildren', () => {
    it('should return only children with status "done"', () => {
      const parent = createPlan(1, 'Parent');
      const completedChild = createPlan(2, 'Completed Child', 'done', 1);
      const pendingChild = createPlan(3, 'Pending Child', 'pending', 1);
      const inProgressChild = createPlan(4, 'In Progress Child', 'in_progress', 1);
      const allPlans = new Map([
        [1, parent],
        [2, completedChild],
        [3, pendingChild],
        [4, inProgressChild],
      ]);

      const completedChildren = getCompletedChildren(1, allPlans);
      expect(completedChildren).toHaveLength(1);
      expect(completedChildren[0]).toEqual(completedChild);
    });

    it('should include completed grandchildren', () => {
      const parent = createPlan(1, 'Parent');
      const child = createPlan(2, 'Child', 'pending', 1);
      const completedGrandchild = createPlan(3, 'Completed Grandchild', 'done', 2);
      const pendingGrandchild = createPlan(4, 'Pending Grandchild', 'pending', 2);
      const allPlans = new Map([
        [1, parent],
        [2, child],
        [3, completedGrandchild],
        [4, pendingGrandchild],
      ]);

      const completedChildren = getCompletedChildren(1, allPlans);
      expect(completedChildren).toHaveLength(1);
      expect(completedChildren[0]).toEqual(completedGrandchild);
    });
  });

  describe('getPendingChildren', () => {
    it('should return only children with status "pending" or "in_progress"', () => {
      const parent = createPlan(1, 'Parent');
      const completedChild = createPlan(2, 'Completed Child', 'done', 1);
      const pendingChild = createPlan(3, 'Pending Child', 'pending', 1);
      const inProgressChild = createPlan(4, 'In Progress Child', 'in_progress', 1);
      const cancelledChild = createPlan(5, 'Cancelled Child', 'cancelled', 1);
      const allPlans = new Map([
        [1, parent],
        [2, completedChild],
        [3, pendingChild],
        [4, inProgressChild],
        [5, cancelledChild],
      ]);

      const pendingChildren = getPendingChildren(1, allPlans);
      expect(pendingChildren).toHaveLength(2);
      expect(pendingChildren).toContain(pendingChild);
      expect(pendingChildren).toContain(inProgressChild);
    });
  });

  describe('hasCycleInParentChain', () => {
    it('should return false for plan with no cycle', () => {
      const grandparent = createPlan(1, 'Grandparent');
      const parent = createPlan(2, 'Parent', 'pending', 1);
      const child = createPlan(3, 'Child', 'pending', 2);
      const allPlans = new Map([
        [1, grandparent],
        [2, parent],
        [3, child],
      ]);

      expect(hasCycleInParentChain(child, allPlans)).toBe(false);
    });

    it('should return true for plan with cycle in parent chain', () => {
      // Create a cycle: 1 -> 2 -> 3 -> 1
      const plan1 = createPlan(1, 'Plan 1', 'pending', 3);
      const plan2 = createPlan(2, 'Plan 2', 'pending', 1);
      const plan3 = createPlan(3, 'Plan 3', 'pending', 2);
      const allPlans = new Map([
        [1, plan1],
        [2, plan2],
        [3, plan3],
      ]);

      expect(hasCycleInParentChain(plan1, allPlans)).toBe(true);
      expect(hasCycleInParentChain(plan2, allPlans)).toBe(true);
      expect(hasCycleInParentChain(plan3, allPlans)).toBe(true);
    });

    it('should return false for plan with missing parent reference', () => {
      const plan = createPlan(1, 'Plan', 'pending', 999); // parent 999 doesn't exist
      const allPlans = new Map([[1, plan]]);

      expect(hasCycleInParentChain(plan, allPlans)).toBe(false);
    });
  });

  describe('getRootPlans', () => {
    it('should return plans with no parent', () => {
      const root1 = createPlan(1, 'Root 1');
      const root2 = createPlan(3, 'Root 2');
      const child = createPlan(2, 'Child', 'pending', 1);
      const allPlans = new Map([
        [1, root1],
        [2, child],
        [3, root2],
      ]);

      const roots = getRootPlans(allPlans);
      expect(roots).toHaveLength(2);
      expect(roots).toContain(root1);
      expect(roots).toContain(root2);
      expect(roots).not.toContain(child);
    });

    it('should return results sorted by ID', () => {
      const root3 = createPlan(5, 'Root 3');
      const root1 = createPlan(1, 'Root 1');
      const root2 = createPlan(3, 'Root 2');
      const allPlans = new Map([
        [1, root1],
        [3, root2],
        [5, root3],
      ]);

      const roots = getRootPlans(allPlans);
      expect(roots.map((r) => r.id)).toEqual([1, 3, 5]);
    });

    it('should return empty array when all plans have parents', () => {
      const parent = createPlan(1, 'Parent', 'pending', 999); // has parent (even if missing)
      const child = createPlan(2, 'Child', 'pending', 1);
      const allPlans = new Map([
        [1, parent],
        [2, child],
      ]);

      const roots = getRootPlans(allPlans);
      expect(roots).toEqual([]);
    });
  });

  describe('Edge cases and robustness', () => {
    it('should handle plans with undefined IDs gracefully', () => {
      const planWithoutId: PlanWithFilename = {
        title: 'Plan without ID',
        goal: 'Some goal',
        tasks: [],
        filename: 'plan.yml',
        // no id field
      };
      const allPlans = new Map();

      // Should not crash
      expect(() => getParentChain(planWithoutId, allPlans)).not.toThrow();
      expect(() => getAllChildren(0, allPlans)).not.toThrow();
      expect(() => getDirectChildren(0, allPlans)).not.toThrow();
    });

    it('should handle empty plans map', () => {
      const plan = createPlan(1, 'Plan');
      const emptyPlans = new Map<number, PlanWithFilename>();

      expect(getParentChain(plan, emptyPlans)).toEqual([]);
      expect(getAllChildren(1, emptyPlans)).toEqual([]);
      expect(getDirectChildren(1, emptyPlans)).toEqual([]);
      expect(getCompletedChildren(1, emptyPlans)).toEqual([]);
      expect(getRootPlans(emptyPlans)).toEqual([]);
    });
  });
});
