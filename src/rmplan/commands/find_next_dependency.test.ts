import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { findNextReadyDependency } from './find_next_dependency.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { PlanSchema } from '../planSchema.js';
import yaml from 'yaml';

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
    expect(result.message).toContain('No ready or pending dependencies found');
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
    expect(result.message).toContain('No ready or pending dependencies found');
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

    expect(result.plan).toBeNull();
    expect(result.message).toContain('No ready or pending dependencies found');
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
});
