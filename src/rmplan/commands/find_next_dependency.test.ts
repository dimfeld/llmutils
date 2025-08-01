import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { findNextReadyDependency } from './find_next_dependency.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { PlanSchema } from '../planSchema.js';
import yaml from 'yaml';
import { ModuleMocker } from '../../testing.js';

describe('findNextReadyDependency', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test files
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'find-next-dep-test-'));
  });

  afterEach(async () => {
    // Clean up the temporary directory
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  async function createPlanFile(plan: PlanSchema & { filename: string }) {
    const filePath = path.join(testDir, plan.filename);

    // Create a proper plan object according to the schema
    const planData: any = {
      id: plan.id,
      title: plan.title,
      goal: plan.goal || 'Test goal',
      status: plan.status || 'pending',
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

    // Write as YAML
    const yamlContent = yaml.stringify(planData);
    await fs.writeFile(filePath, yamlContent, 'utf-8');
  }

  test('finds ready dependency with all dependencies done', async () => {
    // Create a parent plan with dependencies
    await createPlanFile({
      id: 1,
      title: 'Parent Plan',
      filename: '1-parent.yml',
      status: 'in_progress',
      dependencies: [2, 3],
      tasks: [{ title: 'Parent task', description: 'Do parent work' }],
    });

    // Create a done dependency
    await createPlanFile({
      id: 2,
      title: 'Done Dependency',
      filename: '2-done.yml',
      status: 'done',
      tasks: [{ title: 'Done task', description: 'Already completed', done: true }],
    });

    // Create a pending dependency that should be ready
    await createPlanFile({
      id: 3,
      title: 'Ready Dependency',
      filename: '3-ready.yml',
      status: 'pending',
      dependencies: [2], // Depends on plan 2 which is done
      tasks: [{ title: 'Ready task', description: 'Ready to work on' }],
    });

    const result = await findNextReadyDependency(1, testDir);

    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(3);
    expect(result.plan?.title).toBe('Ready Dependency');
    expect(result.message).toContain('Found ready plan');
  });

  test('returns null when no dependencies exist', async () => {
    await createPlanFile({
      id: 1,
      title: 'Standalone Plan',
      filename: '1-standalone.yml',
      status: 'pending',
      tasks: [{ title: 'Solo task', description: 'Work alone' }],
    });

    const result = await findNextReadyDependency(1, testDir);

    expect(result.plan).toBeNull();
    expect(result.message).toContain('No dependencies found for this plan');
  });

  test('handles invalid plan ID', async () => {
    const result = await findNextReadyDependency(999, testDir);

    expect(result.plan).toBeNull();
    expect(result.message).toContain('Plan not found: 999');
  });

  test('handles invalid directory', async () => {
    const result = await findNextReadyDependency(1, '/non/existent/directory');

    expect(result.plan).toBeNull();
    expect(result.message).toContain('Directory not found');
  });

  test('skips dependencies with incomplete dependencies', async () => {
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
      title: 'Incomplete Dependency',
      filename: '3-incomplete.yml',
      status: 'pending', // Not done, so plan 2 is blocked
      tasks: [{ title: 'Incomplete task', description: 'Still working' }],
    });

    const result = await findNextReadyDependency(1, testDir);

    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(3); // Should find plan 3 as it has no dependencies
    expect(result.plan?.title).toBe('Incomplete Dependency');
  });

  test('finds in-progress dependency immediately', async () => {
    await createPlanFile({
      id: 1,
      title: 'Parent Plan',
      filename: '1-parent.yml',
      status: 'done',
      dependencies: [2],
      tasks: [{ title: 'Parent task', description: 'Completed', done: true }],
    });

    await createPlanFile({
      id: 2,
      title: 'In Progress Dependency',
      filename: '2-in-progress.yml',
      status: 'in_progress',
      dependencies: [3], // Even with incomplete dependencies
      tasks: [{ title: 'Active task', description: 'Currently working' }],
    });

    await createPlanFile({
      id: 3,
      title: 'Pending Sub-dependency',
      filename: '3-pending.yml',
      status: 'pending',
      tasks: [{ title: 'Waiting task', description: 'Not started' }],
    });

    const result = await findNextReadyDependency(1, testDir);

    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(2); // Should find the in-progress plan
    expect(result.plan?.title).toBe('In Progress Dependency');
  });

  test('handles child plans through parent field', async () => {
    await createPlanFile({
      id: 1,
      title: 'Parent Plan',
      filename: '1-parent.yml',
      status: 'in_progress',
      tasks: [{ title: 'Parent task', description: 'Do parent work' }],
    });

    // Child plan with parent field pointing to plan 1
    await createPlanFile({
      id: 2,
      title: 'Child Plan',
      filename: '2-child.yml',
      status: 'pending',
      parent: 1,
      tasks: [{ title: 'Child task', description: 'Do child work' }],
    });

    const result = await findNextReadyDependency(1, testDir);

    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(2);
    expect(result.plan?.title).toBe('Child Plan');
  });

  test('handles complex multi-level dependency chains', async () => {
    // Create a complex dependency tree:
    // 1 -> 2 -> 4
    //   -> 3 -> 5 -> 6
    await createPlanFile({
      id: 1,
      title: 'Root Plan',
      filename: '1-root.yml',
      status: 'in_progress',
      dependencies: [2, 3],
      tasks: [{ title: 'Root task', description: 'Start here' }],
    });

    await createPlanFile({
      id: 2,
      title: 'Branch A',
      filename: '2-branch-a.yml',
      status: 'done',
      dependencies: [4],
      tasks: [{ title: 'Branch A task', description: 'Completed', done: true }],
    });

    await createPlanFile({
      id: 3,
      title: 'Branch B',
      filename: '3-branch-b.yml',
      status: 'done',
      dependencies: [5],
      tasks: [{ title: 'Branch B task', description: 'Completed', done: true }],
    });

    await createPlanFile({
      id: 4,
      title: 'Leaf A',
      filename: '4-leaf-a.yml',
      status: 'pending',
      tasks: [{ title: 'Leaf A task', description: 'Ready to work' }],
    });

    await createPlanFile({
      id: 5,
      title: 'Branch B Sub',
      filename: '5-branch-b-sub.yml',
      status: 'done',
      dependencies: [6],
      tasks: [{ title: 'Sub task', description: 'Completed', done: true }],
    });

    await createPlanFile({
      id: 6,
      title: 'Leaf B',
      filename: '6-leaf-b.yml',
      status: 'pending',
      tasks: [{ title: 'Leaf B task', description: 'Ready to work' }],
    });

    const result = await findNextReadyDependency(1, testDir);

    // Should find plan 4 first due to BFS order (2 comes before 3)
    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(4);
    expect(result.plan?.title).toBe('Leaf A');
  });

  test('handles circular dependencies gracefully', async () => {
    // Create a circular dependency: 1 -> 2 -> 3 -> 2
    await createPlanFile({
      id: 1,
      title: 'Start Plan',
      filename: '1-start.yml',
      status: 'in_progress',
      dependencies: [2],
      tasks: [{ title: 'Start task', description: 'Begin here' }],
    });

    await createPlanFile({
      id: 2,
      title: 'Middle Plan',
      filename: '2-middle.yml',
      status: 'pending',
      dependencies: [3],
      tasks: [{ title: 'Middle task', description: 'In the loop' }],
    });

    await createPlanFile({
      id: 3,
      title: 'End Plan',
      filename: '3-end.yml',
      status: 'pending',
      dependencies: [2], // Circular reference back to 2
      tasks: [{ title: 'End task', description: 'Points back' }],
    });

    const result = await findNextReadyDependency(1, testDir);

    // Should handle the circular dependency without infinite loop
    expect(result.plan).toBeNull();
    expect(result.message).toContain('dependencies are blocked by incomplete prerequisites');
  });

  test('skips pending plans with no tasks', async () => {
    await createPlanFile({
      id: 1,
      title: 'Parent Plan',
      filename: '1-parent.yml',
      status: 'in_progress',
      dependencies: [2],
      tasks: [{ title: 'Parent task', description: 'Has work' }],
    });

    await createPlanFile({
      id: 2,
      title: 'Empty Plan',
      filename: '2-empty.yml',
      status: 'pending',
      dependencies: [3],
      tasks: [], // No tasks defined
    });

    await createPlanFile({
      id: 3,
      title: 'Child Plan',
      filename: '3-child.yml',
      status: 'pending',
      tasks: [{ title: 'Child task', description: 'Has actual work' }],
    });

    const result = await findNextReadyDependency(1, testDir);

    // Should skip plan 2 (no tasks) and find plan 3
    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(3);
    expect(result.plan?.title).toBe('Child Plan');
  });

  test('handles mixed states with multiple ready dependencies', async () => {
    await createPlanFile({
      id: 1,
      title: 'Root Plan',
      filename: '1-root.yml',
      status: 'in_progress',
      dependencies: [2, 3, 4, 5],
      tasks: [{ title: 'Root task', description: 'Main work' }],
    });

    await createPlanFile({
      id: 2,
      title: 'Done Plan',
      filename: '2-done.yml',
      status: 'done',
      tasks: [{ title: 'Done task', description: 'Completed', done: true }],
    });

    await createPlanFile({
      id: 3,
      title: 'In Progress Plan',
      filename: '3-in-progress.yml',
      status: 'in_progress',
      dependencies: [6], // Has a dependency but still actionable
      tasks: [{ title: 'Active task', description: 'Currently working' }],
    });

    await createPlanFile({
      id: 4,
      title: 'Blocked Plan',
      filename: '4-blocked.yml',
      status: 'pending',
      dependencies: [7], // Depends on a pending plan
      tasks: [{ title: 'Blocked task', description: 'Cannot start' }],
    });

    await createPlanFile({
      id: 5,
      title: 'Ready Plan',
      filename: '5-ready.yml',
      status: 'pending',
      tasks: [{ title: 'Ready task', description: 'Can start' }],
    });

    await createPlanFile({
      id: 6,
      title: 'Sub Dependency',
      filename: '6-sub.yml',
      status: 'pending',
      tasks: [{ title: 'Sub task', description: 'Dependency of 3' }],
    });

    await createPlanFile({
      id: 7,
      title: 'Blocker Plan',
      filename: '7-blocker.yml',
      status: 'pending',
      tasks: [{ title: 'Blocker task', description: 'Blocks plan 4' }],
    });

    const result = await findNextReadyDependency(1, testDir);

    // Should find plan 3 (in_progress) first as it's actionable immediately
    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(3);
    expect(result.plan?.title).toBe('In Progress Plan');
    expect(result.message).toContain('Found in-progress plan');
  });

  test('handles missing dependency files gracefully', async () => {
    await createPlanFile({
      id: 1,
      title: 'Parent Plan',
      filename: '1-parent.yml',
      status: 'in_progress',
      dependencies: [2, 999], // 999 doesn't exist
      tasks: [{ title: 'Parent task', description: 'Has missing dependency' }],
    });

    await createPlanFile({
      id: 2,
      title: 'Valid Dependency',
      filename: '2-valid.yml',
      status: 'pending',
      tasks: [{ title: 'Valid task', description: 'Exists' }],
    });

    const result = await findNextReadyDependency(1, testDir);

    // Should handle missing dependency gracefully and find plan 2
    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(2);
    expect(result.plan?.title).toBe('Valid Dependency');
  });

  test('returns correct message when all dependencies are done', async () => {
    await createPlanFile({
      id: 1,
      title: 'Parent Plan',
      filename: '1-parent.yml',
      status: 'in_progress',
      dependencies: [2, 3],
      tasks: [{ title: 'Parent task', description: 'Main work' }],
    });

    await createPlanFile({
      id: 2,
      title: 'Done Dep 1',
      filename: '2-done1.yml',
      status: 'done',
      tasks: [{ title: 'Done task 1', description: 'Completed', done: true }],
    });

    await createPlanFile({
      id: 3,
      title: 'Done Dep 2',
      filename: '3-done2.yml',
      status: 'done',
      tasks: [{ title: 'Done task 2', description: 'Completed', done: true }],
    });

    const result = await findNextReadyDependency(1, testDir);

    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(1);
    expect(result.plan?.title).toBe('Parent Plan');
    expect(result.message).toContain('All dependencies are complete');
  });

  test('handles both dependencies array and parent field together', async () => {
    await createPlanFile({
      id: 1,
      title: 'Main Plan',
      filename: '1-main.yml',
      status: 'in_progress',
      dependencies: [2], // Explicit dependency
      tasks: [{ title: 'Main task', description: 'Primary work' }],
    });

    await createPlanFile({
      id: 2,
      title: 'Explicit Dependency',
      filename: '2-explicit.yml',
      status: 'done',
      tasks: [{ title: 'Explicit task', description: 'Done', done: true }],
    });

    await createPlanFile({
      id: 3,
      title: 'Child via Parent',
      filename: '3-child.yml',
      status: 'pending',
      parent: 1, // Implicit dependency via parent field
      tasks: [{ title: 'Child task', description: 'Ready' }],
    });

    await createPlanFile({
      id: 4,
      title: 'Another Child',
      filename: '4-another-child.yml',
      status: 'pending',
      parent: 1, // Another child
      dependencies: [2], // Also depends on plan 2
      tasks: [{ title: 'Another task', description: 'Also ready' }],
    });

    const result = await findNextReadyDependency(1, testDir);

    // Should find one of the child plans (BFS order determines which)
    expect(result.plan).not.toBeNull();
    expect([3, 4]).toContain(result.plan?.id);
  });

  test('respects priority order when multiple plans are ready', async () => {
    await createPlanFile({
      id: 1,
      title: 'Parent Plan',
      filename: '1-parent.yml',
      status: 'in_progress',
      dependencies: [2, 3, 4, 5],
      tasks: [{ title: 'Parent task', description: 'Main work' }],
    });

    await createPlanFile({
      id: 2,
      title: 'Low Priority',
      filename: '2-low.yml',
      status: 'pending',
      priority: 'low',
      tasks: [{ title: 'Low task', description: 'Low priority work' }],
    });

    await createPlanFile({
      id: 3,
      title: 'High Priority',
      filename: '3-high.yml',
      status: 'pending',
      priority: 'high',
      tasks: [{ title: 'High task', description: 'High priority work' }],
    });

    await createPlanFile({
      id: 4,
      title: 'Medium Priority',
      filename: '4-medium.yml',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Medium task', description: 'Medium priority work' }],
    });

    await createPlanFile({
      id: 5,
      title: 'Urgent Priority',
      filename: '5-urgent.yml',
      status: 'pending',
      priority: 'urgent',
      tasks: [{ title: 'Urgent task', description: 'Urgent work' }],
    });

    const result = await findNextReadyDependency(1, testDir);

    // Should find the urgent priority plan first
    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(5);
    expect(result.plan?.title).toBe('Urgent Priority');
  });

  test('skips plans with maybe priority', async () => {
    await createPlanFile({
      id: 1,
      title: 'Parent Plan',
      filename: '1-parent.yml',
      status: 'in_progress',
      dependencies: [2, 3, 4],
      tasks: [{ title: 'Parent task', description: 'Main work' }],
    });

    await createPlanFile({
      id: 2,
      title: 'Maybe Priority Plan',
      filename: '2-maybe.yml',
      status: 'pending',
      priority: 'maybe',
      tasks: [{ title: 'Maybe task', description: 'Not sure if needed' }],
    });

    await createPlanFile({
      id: 3,
      title: 'Another Maybe',
      filename: '3-maybe.yml',
      status: 'pending',
      priority: 'maybe',
      dependencies: [2], // Even if dependencies are done
      tasks: [{ title: 'Another maybe', description: 'Also uncertain' }],
    });

    await createPlanFile({
      id: 4,
      title: 'Regular Plan',
      filename: '4-regular.yml',
      status: 'pending',
      tasks: [{ title: 'Regular task', description: 'Should be found' }],
    });

    const result = await findNextReadyDependency(1, testDir);

    // Should skip the 'maybe' priority plans and find plan 4
    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(4);
    expect(result.plan?.title).toBe('Regular Plan');
  });

  test('handles no priority as lowest priority', async () => {
    await createPlanFile({
      id: 1,
      title: 'Parent Plan',
      filename: '1-parent.yml',
      status: 'in_progress',
      dependencies: [2, 3, 4],
      tasks: [{ title: 'Parent task', description: 'Main work' }],
    });

    await createPlanFile({
      id: 2,
      title: 'No Priority',
      filename: '2-no-priority.yml',
      status: 'pending',
      // No priority field
      tasks: [{ title: 'No priority task', description: 'Default priority' }],
    });

    await createPlanFile({
      id: 3,
      title: 'Low Priority',
      filename: '3-low.yml',
      status: 'pending',
      priority: 'low',
      tasks: [{ title: 'Low task', description: 'Low priority' }],
    });

    await createPlanFile({
      id: 4,
      title: 'Medium Priority',
      filename: '4-medium.yml',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Medium task', description: 'Medium priority' }],
    });

    const result = await findNextReadyDependency(1, testDir);

    // Should find the medium priority plan first (highest priority among ready plans)
    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(4);
    expect(result.plan?.title).toBe('Medium Priority');
  });

  test('in-progress plans take precedence over priority', async () => {
    await createPlanFile({
      id: 1,
      title: 'Parent Plan',
      filename: '1-parent.yml',
      status: 'in_progress',
      dependencies: [2, 3],
      tasks: [{ title: 'Parent task', description: 'Main work' }],
    });

    await createPlanFile({
      id: 2,
      title: 'In Progress Low Priority',
      filename: '2-in-progress-low.yml',
      status: 'in_progress',
      priority: 'low',
      tasks: [{ title: 'Active task', description: 'Currently working' }],
    });

    await createPlanFile({
      id: 3,
      title: 'Pending Urgent Priority',
      filename: '3-pending-urgent.yml',
      status: 'pending',
      priority: 'urgent',
      tasks: [{ title: 'Urgent task', description: 'Very important but not started' }],
    });

    const result = await findNextReadyDependency(1, testDir);

    // Should find the in-progress plan even though it has lower priority
    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(2);
    expect(result.plan?.title).toBe('In Progress Low Priority');
    expect(result.message).toContain('Found in-progress plan');
  });

  // Error handling tests
  describe('error handling and messages', () => {
    test('provides helpful message for invalid plan ID', async () => {
      const result = await findNextReadyDependency(999, testDir);

      expect(result.plan).toBeNull();
      expect(result.message).toContain('Plan not found: 999');
      expect(result.message).toContain('rmplan list');
      expect(result.message).toContain('Check the plan ID is correct');
    });

    test('provides helpful message for invalid directory with permission suggestion', async () => {
      const result = await findNextReadyDependency(1, '/root/restricted/directory');

      expect(result.plan).toBeNull();
      expect(result.message).toContain('Directory not found');
      expect(result.message).toContain('Check the path is correct');
      expect(result.message).toContain('permissions');
    });

    test('provides detailed message when no dependencies are ready - all done', async () => {
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2, 3],
        tasks: [{ title: 'Parent task', description: 'Main work' }],
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

      const result = await findNextReadyDependency(1, testDir);

      expect(result.plan).not.toBeNull();
      expect(result.plan?.id).toBe(1);
      expect(result.plan?.title).toBe('Parent Plan');
      expect(result.message).toContain('All dependencies are complete');
      expect(result.message).toContain('ready to work on the parent plan');
    });

    test('does not return parent plan when it is already done', async () => {
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'done',
        dependencies: [2, 3],
        tasks: [{ title: 'Parent task', description: 'Main work', done: true }],
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

      const result = await findNextReadyDependency(1, testDir);

      expect(result.plan).toBeNull();
      expect(result.message).toContain('No ready dependencies found');
      expect(result.message).toContain('All dependencies are complete');
    });

    test('provides detailed message when dependencies are blocked by incomplete prerequisites', async () => {
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2],
        tasks: [{ title: 'Parent task', description: 'Main work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Blocked Dependency',
        filename: '2-blocked.yml',
        status: 'pending',
        dependencies: [3],
        tasks: [{ title: 'Blocked task', description: 'Cannot start yet' }],
      });

      await createPlanFile({
        id: 3,
        title: 'Incomplete Prerequisite',
        filename: '3-incomplete.yml',
        status: 'pending',
        dependencies: [4], // Has unfulfilled dependency
        tasks: [{ title: 'Incomplete task', description: 'Still blocked' }],
      });

      await createPlanFile({
        id: 4,
        title: 'Deep Incomplete',
        filename: '4-deep.yml',
        status: 'pending',
        dependencies: [5], // Another level of blocking
        tasks: [{ title: 'Deep task', description: 'Multiple levels down' }],
      });

      await createPlanFile({
        id: 5,
        title: 'Ready Base Plan',
        filename: '5-ready.yml',
        status: 'pending',
        // No dependencies - this should be ready
        tasks: [{ title: 'Ready task', description: 'Can start immediately' }],
      });

      const result = await findNextReadyDependency(1, testDir);

      expect(result.plan).not.toBeNull(); // Should find plan 5 as it has no dependencies
      expect(result.plan?.id).toBe(5);
      expect(result.plan?.title).toBe('Ready Base Plan');
    });

    test('explains when dependencies are blocked by tasks without steps', async () => {
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2],
        tasks: [{ title: 'Parent task', description: 'Main work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'No Tasks Plan',
        filename: '2-no-tasks.yml',
        status: 'pending',
        tasks: [], // No tasks defined - should be skipped
      });

      const result = await findNextReadyDependency(1, testDir);

      expect(result.plan).toBeNull();
      expect(result.message).toContain('dependencies have no actionable tasks');
      expect(result.message).toContain('rmplan prepare');
    });

    test('explains when all dependencies have maybe priority', async () => {
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2, 3],
        tasks: [{ title: 'Parent task', description: 'Main work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Maybe Dependency 1',
        filename: '2-maybe1.yml',
        status: 'pending',
        priority: 'maybe',
        tasks: [{ title: 'Maybe task 1', description: 'Uncertain work' }],
      });

      await createPlanFile({
        id: 3,
        title: 'Maybe Dependency 2',
        filename: '3-maybe2.yml',
        status: 'pending',
        priority: 'maybe',
        tasks: [{ title: 'Maybe task 2', description: 'Uncertain work' }],
      });

      const result = await findNextReadyDependency(1, testDir);

      expect(result.plan).toBeNull();
      expect(result.message).toContain('dependencies have \"maybe\" priority');
      expect(result.message).toContain('Review and update priorities');
    });

    test('provides clear message format with consistent styling', async () => {
      // Test that error messages use consistent formatting
      const result = await findNextReadyDependency(999, testDir);

      // Should contain structured, actionable guidance
      expect(result.message).toMatch(/Plan not found: 999/);
      expect(result.message).toContain('→'); // Should use arrow for suggestions
      expect(result.message).toMatch(/Try:/); // Should provide clear next steps
    });

    test('handles corrupted directory gracefully', async () => {
      // Use a completely non-existent path
      const fakeDirPath = '/absolutely/nonexistent/path/that/will/never/exist';

      const result = await findNextReadyDependency(1, fakeDirPath);

      expect(result.plan).toBeNull();
      expect(result.message).toContain('Directory not found');
      expect(result.message).toContain('Check the path is correct');
    });

    test('handles empty directory with helpful message', async () => {
      const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-test-'));

      const result = await findNextReadyDependency(1, emptyDir);

      expect(result.plan).toBeNull();
      expect(result.message).toContain('Plan not found: 1');
      expect(result.message).toContain('rmplan list');

      // Clean up
      await fs.rm(emptyDir, { recursive: true, force: true });
    });
  });

  // Debug logging tests
  describe('debug logging', () => {
    let moduleMocker: ModuleMocker;
    let mockDebugLog: any;
    let capturedLogs: string[];

    beforeEach(async () => {
      moduleMocker = new ModuleMocker(import.meta);
      capturedLogs = [];
      mockDebugLog = mock((message: string) => {
        capturedLogs.push(message);
      });

      await moduleMocker.mock('../../logging.js', () => ({
        debugLog: mockDebugLog,
      }));
    });

    afterEach(() => {
      moduleMocker.clear();
    });

    test('logs BFS traversal with plan examination and dependency discovery', async () => {
      // Create a dependency chain: 1 -> 2 -> 3
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2],
        tasks: [{ title: 'Parent task', description: 'Main work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Middle Dependency',
        filename: '2-middle.yml',
        status: 'done',
        dependencies: [3],
        tasks: [{ title: 'Middle task', description: 'Completed', done: true }],
      });

      await createPlanFile({
        id: 3,
        title: 'Leaf Dependency',
        filename: '3-leaf.yml',
        status: 'pending',
        tasks: [{ title: 'Leaf task', description: 'Ready to work' }],
      });

      await findNextReadyDependency(1, testDir);

      // Verify parent plan discovery logging
      expect(
        capturedLogs.some((log) =>
          log.includes('[find_next_dependency] Parent plan found: Parent Plan (1)')
        )
      ).toBe(true);

      // Verify BFS traversal logging
      expect(
        capturedLogs.some((log) =>
          log.includes('[find_next_dependency] Starting BFS traversal from plan 1')
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) => log.includes('[find_next_dependency] BFS: Examining plan 1'))
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes('[find_next_dependency] BFS: Skipping plan 1 - is parent plan')
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) => log.includes('[find_next_dependency] BFS: Examining plan 2'))
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes('[find_next_dependency] BFS: Added plan 2 to dependencies')
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes('[find_next_dependency] BFS: Found 1 direct dependencies for plan 2: [3]')
        )
      ).toBe(true);

      // Verify BFS completion logging
      expect(
        capturedLogs.some((log) =>
          log.includes('[find_next_dependency] BFS complete: Found 2 total dependencies: [2, 3]')
        )
      ).toBe(true);
    });

    test('logs candidate filtering with status explanations', async () => {
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2, 3, 4],
        tasks: [{ title: 'Parent task', description: 'Main work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Done Plan',
        filename: '2-done.yml',
        status: 'done',
        tasks: [{ title: 'Done task', description: 'Completed', done: true }],
      });

      await createPlanFile({
        id: 3,
        title: 'Pending Plan',
        filename: '3-pending.yml',
        status: 'pending',
        tasks: [{ title: 'Pending task', description: 'Ready to work' }],
      });

      await createPlanFile({
        id: 4,
        title: 'In Progress Plan',
        filename: '4-in-progress.yml',
        status: 'in_progress',
        tasks: [{ title: 'Active task', description: 'Currently working' }],
      });

      await findNextReadyDependency(1, testDir);

      // Verify status filtering logging
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] Filtering candidates by status (pending or in_progress)'
          )
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] Filtering: Excluding plan 2 "Done Plan" (status: done)'
          )
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] Filtering: Including plan 3 "Pending Plan" (status: pending)'
          )
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] Filtering: Including plan 4 "In Progress Plan" (status: in_progress)'
          )
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes('[find_next_dependency] Status filtering complete: 2 candidates remain')
        )
      ).toBe(true);
    });

    test('logs readiness filtering with priority and task explanations', async () => {
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2, 3, 4, 5],
        tasks: [{ title: 'Parent task', description: 'Main work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Maybe Priority Plan',
        filename: '2-maybe.yml',
        status: 'pending',
        priority: 'maybe',
        tasks: [{ title: 'Maybe task', description: 'Uncertain work' }],
      });

      await createPlanFile({
        id: 3,
        title: 'No Tasks Plan',
        filename: '3-no-tasks.yml',
        status: 'pending',
        tasks: [],
      });

      await createPlanFile({
        id: 4,
        title: 'Blocked Plan',
        filename: '4-blocked.yml',
        status: 'pending',
        dependencies: [6], // Depends on non-existent plan
        tasks: [{ title: 'Blocked task', description: 'Cannot start' }],
      });

      await createPlanFile({
        id: 5,
        title: 'Ready Plan',
        filename: '5-ready.yml',
        status: 'pending',
        tasks: [{ title: 'Ready task', description: 'Can start' }],
      });

      await findNextReadyDependency(1, testDir);

      // Verify readiness filtering logging
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] Filtering candidates for readiness (priority, tasks, dependencies)'
          )
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] Readiness: Excluding plan 2 "Maybe Priority Plan" - has \'maybe\' priority'
          )
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] Readiness: Excluding plan 3 "No Tasks Plan" - no tasks defined'
          )
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] Readiness: Including plan 5 "Ready Plan" - no dependencies to block it'
          )
        )
      ).toBe(true);
    });

    test('logs sorting logic and final selection with explanations', async () => {
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2, 3, 4],
        tasks: [{ title: 'Parent task', description: 'Main work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Low Priority Plan',
        filename: '2-low.yml',
        status: 'pending',
        priority: 'low',
        tasks: [{ title: 'Low task', description: 'Low priority work' }],
      });

      await createPlanFile({
        id: 3,
        title: 'High Priority Plan',
        filename: '3-high.yml',
        status: 'pending',
        priority: 'high',
        tasks: [{ title: 'High task', description: 'High priority work' }],
      });

      await createPlanFile({
        id: 4,
        title: 'In Progress Plan',
        filename: '4-in-progress.yml',
        status: 'in_progress',
        priority: 'low',
        tasks: [{ title: 'Active task', description: 'Currently working' }],
      });

      await findNextReadyDependency(1, testDir);

      // Verify sorting logging
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] Sorting 3 candidates by: status (in_progress > pending), priority (high > low), ID (ascending)'
          )
        )
      ).toBe(true);

      // Verify before sort logging shows all candidates
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] Before sort [0]: Plan 2 "Low Priority Plan" (status: pending, priority: low)'
          )
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] Before sort [1]: Plan 3 "High Priority Plan" (status: pending, priority: high)'
          )
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] Before sort [2]: Plan 4 "In Progress Plan" (status: in_progress, priority: low)'
          )
        )
      ).toBe(true);

      // Verify after sort logging shows proper ordering (in_progress first, then by priority)
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] After sort [0]: Plan 4 "In Progress Plan" (status: in_progress, priority: low)'
          )
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] After sort [1]: Plan 3 "High Priority Plan" (status: pending, priority: high)'
          )
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] After sort [2]: Plan 2 "Low Priority Plan" (status: pending, priority: low)'
          )
        )
      ).toBe(true);

      // Verify final selection logging
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] SELECTED: Plan 4 "In Progress Plan" (status: in_progress, priority: low)'
          )
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] Selection reason: First candidate after sorting by status > priority > ID'
          )
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes('[find_next_dependency] Returning in-progress plan 4: In Progress Plan')
        )
      ).toBe(true);
    });

    test('logs circular dependency detection', async () => {
      // Create circular dependency: 1 -> 2 -> 3 -> 2
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2],
        tasks: [{ title: 'Parent task', description: 'Main work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Circular Plan A',
        filename: '2-circular-a.yml',
        status: 'pending',
        dependencies: [3],
        tasks: [{ title: 'Circular task A', description: 'Part of loop' }],
      });

      await createPlanFile({
        id: 3,
        title: 'Circular Plan B',
        filename: '3-circular-b.yml',
        status: 'pending',
        dependencies: [2], // Creates circular reference
        tasks: [{ title: 'Circular task B', description: 'Points back' }],
      });

      await findNextReadyDependency(1, testDir);

      // Verify circular dependency detection logging
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] BFS: Skipping plan 2 - already visited (circular reference)'
          )
        )
      ).toBe(true);
    });

    test('logs no ready candidates analysis', async () => {
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2],
        tasks: [{ title: 'Parent task', description: 'Main work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Done Plan',
        filename: '2-done.yml',
        status: 'done',
        tasks: [{ title: 'Done task', description: 'Completed', done: true }],
      });

      await findNextReadyDependency(1, testDir);

      // Verify no ready candidates logging
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] No ready candidates found - analyzing why dependencies are not ready'
          )
        )
      ).toBe(true);
    });

    test('logs dependency blocking analysis', async () => {
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2],
        tasks: [{ title: 'Parent task', description: 'Main work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Blocked Plan',
        filename: '2-blocked.yml',
        status: 'pending',
        dependencies: [3],
        tasks: [{ title: 'Blocked task', description: 'Cannot start' }],
      });

      await createPlanFile({
        id: 3,
        title: 'Incomplete Plan',
        filename: '3-incomplete.yml',
        status: 'pending',
        tasks: [{ title: 'Incomplete task', description: 'Still working' }],
      });

      await findNextReadyDependency(1, testDir);

      // Verify dependency blocking analysis
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] Readiness: Plan 2 "Blocked Plan" blocked by dependency 3 (status: pending)'
          )
        )
      ).toBe(true);
      expect(
        capturedLogs.some((log) =>
          log.includes(
            '[find_next_dependency] Readiness: Excluding plan 2 "Blocked Plan" - has incomplete dependencies'
          )
        )
      ).toBe(true);
    });
  });
});
