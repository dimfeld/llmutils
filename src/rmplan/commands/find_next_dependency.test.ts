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
});

