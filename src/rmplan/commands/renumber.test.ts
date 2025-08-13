import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'yaml';
import { handleRenumber } from './renumber.js';
import { type PlanSchema } from '../planSchema.js';
import { readPlanFile } from '../plans.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

function writeTestPlan(path: string, plan: any) {
  return Bun.write(path, yaml.stringify(plan));
}

describe('rmplan renumber', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rmplan-renumber-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.promises.mkdir(tasksDir, { recursive: true });

    // Mock getGitRoot to return the temp directory
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
    }));

    // Create a config file
    configPath = path.join(tempDir, '.rmplan.yml');
    await Bun.write(
      configPath,
      yaml.stringify({
        paths: {
          tasks: 'tasks', // Use relative path since we're mocking git root
        },
      })
    );
  });

  afterEach(async () => {
    moduleMocker.clear();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const createMockCommand = () => ({
    parent: {
      opts: () => ({ config: configPath }),
    },
  });

  const createPlan = async (
    id: string | number,
    title: string,
    filename?: string,
    createdAt?: string
  ): Promise<void> => {
    const plan: PlanSchema = {
      // @ts-expect-error for testing this needs to possibly be a string
      id,
      title,
      goal: `Goal for ${title}`,
      details: `Details for ${title}`,
      status: 'pending',
      priority: 'medium',
      createdAt: createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    // Use provided filename or default to id-based filename
    const file = filename || `${id}.yml`;
    const data = yaml.stringify(plan);
    await Bun.write(path.join(tasksDir, file), data);
  };

  test('resolves ID conflicts based on createdAt timestamp', async () => {
    // Create conflicting plans
    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();

    // Create two plans with the same ID 1 but different filenames
    await createPlan(1, 'Older plan', '1-old.yml', oldTime);
    await createPlan(1, 'Newer plan', '1-new.yml', newTime);

    await handleRenumber({}, createMockCommand());

    // Check that files still exist
    const files = await fs.promises.readdir(tasksDir);
    expect(files).toContain('1-old.yml');
    expect(files).toContain('2-new.yml');

    // Check that IDs were updated correctly
    const oldPlan = await readPlanFile(path.join(tasksDir, '1-old.yml'));
    expect(oldPlan.id).toBe(1); // Older plan keeps ID 1
    expect(oldPlan.title).toBe('Older plan');

    // The plan file should be renamed since it started with the plan ID
    const newPlan = await readPlanFile(path.join(tasksDir, '2-new.yml'));
    expect(newPlan.id).toBe(2); // Newer plan gets ID 2
    expect(newPlan.title).toBe('Newer plan');
  });

  test('dry run does not make changes', async () => {
    await createPlan(123, 'Test plan');

    // Read original content
    const originalPlan = yaml.parse(await Bun.file(path.join(tasksDir, '123.yml')).text());
    expect(originalPlan.id).toBe(123);

    await handleRenumber({ dryRun: true }, createMockCommand());

    // Verify the file still has original content
    const planAfter = yaml.parse(await Bun.file(path.join(tasksDir, '123.yml')).text());
    expect(planAfter.id).toBe(123);
    expect(planAfter).toEqual(originalPlan);
  });

  test('handles empty tasks directory', async () => {
    await handleRenumber({}, createMockCommand());
    // Should complete without errors
  });

  test('handles plans with missing createdAt', async () => {
    // Create a plan without createdAt
    const plan = {
      title: 'Plan without date',
      goal: 'Goal for plan without date',
      details: 'Details for plan without date',
      status: 'pending',
      priority: 'medium',
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '999.yml'), yaml.stringify(plan));

    await handleRenumber({}, createMockCommand());

    // Should renumber successfully
    const updatedPlan = await readPlanFile(path.join(tasksDir, '999.yml'));
    expect(updatedPlan.id).toBe(1);
    expect(updatedPlan.title).toBe('Plan without date');
  });

  test('renumbers two sets of conflicting plans with dependencies preserved', async () => {
    // Create first set of plans with IDs 1, 2, 3, 4
    const set1ParentPlan: PlanSchema = {
      id: 1,
      title: 'Set 1',
      goal: 'Goal for set 1',
      details: 'Details for set 1',
      status: 'pending',
      priority: 'medium',
      dependencies: [2, 3, 4],
      createdAt: new Date('2024-01-01').toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    const set1Plan1: PlanSchema = {
      id: 2,
      parent: 1,
      title: 'Set 1 - Plan 1',
      goal: 'Goal 1-1',
      details: 'Details 1-1',
      status: 'pending',
      priority: 'medium',
      dependencies: [],
      createdAt: new Date('2024-01-01').toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    const set1Plan2: PlanSchema = {
      id: 3,
      parent: 1,
      title: 'Set 1 - Plan 2',
      goal: 'Goal 1-2',
      details: 'Details 1-2',
      status: 'pending',
      priority: 'medium',
      dependencies: [2], // depends on plan 1
      createdAt: new Date('2024-01-02').toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    const set1Plan3: PlanSchema = {
      id: 4,
      parent: 1,
      title: 'Set 1 - Plan 3',
      goal: 'Goal 1-3',
      details: 'Details 1-3',
      status: 'pending',
      priority: 'medium',
      dependencies: [2, 3], // depends on plans 1 and 2
      createdAt: new Date('2024-01-03').toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    // Create second set of plans with IDs 1, 2, 3, 4 (conflicting)
    const set2ParentPlan: PlanSchema = {
      id: 1,
      title: 'Set 2',
      goal: 'Goal for set 2',
      details: 'Details for set 2',
      status: 'pending',
      priority: 'medium',
      dependencies: [2, 3, 4],
      createdAt: new Date('2024-02-01').toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    const set2Plan1: PlanSchema = {
      id: 2,
      parent: 1,
      title: 'Set 2 - Plan 1',
      goal: 'Goal 2-1',
      details: 'Details 2-1',
      status: 'pending',
      priority: 'medium',
      dependencies: [],
      createdAt: new Date('2024-02-01').toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    const set2Plan2: PlanSchema = {
      id: 3,
      parent: 1,
      title: 'Set 2 - Plan 2',
      goal: 'Goal 2-2',
      details: 'Details 2-2',
      status: 'pending',
      priority: 'medium',
      dependencies: [2], // depends on plan 1
      createdAt: new Date('2024-02-02').toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    const set2Plan3: PlanSchema = {
      id: 4,
      parent: 1,
      title: 'Set 2 - Plan 3',
      goal: 'Goal 2-3',
      details: 'Details 2-3',
      status: 'pending',
      priority: 'medium',
      dependencies: [2, 3], // depends on plans 1 and 2
      createdAt: new Date('2024-02-03').toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    // Write all plans with unique filenames
    await writeTestPlan(path.join(tasksDir, '1-set1-parent.yml'), set1ParentPlan);
    await writeTestPlan(path.join(tasksDir, '1-set1/2-plan1.yml'), set1Plan1);
    await writeTestPlan(path.join(tasksDir, '1-set1/3-plan2.yml'), set1Plan2);
    await writeTestPlan(path.join(tasksDir, '1-set1/4-plan3.yml'), set1Plan3);
    await writeTestPlan(path.join(tasksDir, '1-set2-parent.yml'), set2ParentPlan);
    await writeTestPlan(path.join(tasksDir, '1-set2/2-plan1.yml'), set2Plan1);
    await writeTestPlan(path.join(tasksDir, '1-set2/3-plan2.yml'), set2Plan2);
    await writeTestPlan(path.join(tasksDir, '1-set2/4-plan3.yml'), set2Plan3);

    await handleRenumber({}, createMockCommand());

    // Read all updated plans
    const updatedSet1ParentPlan = await readPlanFile(path.join(tasksDir, '1-set1-parent.yml'));
    const updatedSet1Plan1 = await readPlanFile(path.join(tasksDir, '1-set1/2-plan1.yml'));
    const updatedSet1Plan2 = await readPlanFile(path.join(tasksDir, '1-set1/3-plan2.yml'));
    const updatedSet1Plan3 = await readPlanFile(path.join(tasksDir, '1-set1/4-plan3.yml'));
    const updatedSet2ParentPlan = await readPlanFile(path.join(tasksDir, '5-set2-parent.yml'));
    const updatedSet2Plan1 = await readPlanFile(path.join(tasksDir, '5-set2/6-plan1.yml'));
    const updatedSet2Plan2 = await readPlanFile(path.join(tasksDir, '5-set2/7-plan2.yml'));
    const updatedSet2Plan3 = await readPlanFile(path.join(tasksDir, '5-set2/8-plan3.yml'));

    // First set should keep IDs 1, 2, 3, 4 (older timestamps)
    expect(updatedSet1ParentPlan.id).toBe(1);
    expect(updatedSet1Plan1.parent).toBe(1);
    expect(updatedSet1Plan2.parent).toBe(1);
    expect(updatedSet1Plan3.parent).toBe(1);
    expect(updatedSet1Plan1.id).toBe(2);
    expect(updatedSet1Plan2.id).toBe(3);
    expect(updatedSet1Plan3.id).toBe(4);

    // Second set should be renumbered to 4, 5, 6, 7
    expect(updatedSet2ParentPlan.id).toBe(5);
    expect(updatedSet2Plan1.parent).toBe(5);
    expect(updatedSet2Plan2.parent).toBe(5);
    expect(updatedSet2Plan3.parent).toBe(5);
    expect(updatedSet2Plan1.id).toBe(6);
    expect(updatedSet2Plan2.id).toBe(7);
    expect(updatedSet2Plan3.id).toBe(8);

    // Check that dependencies are preserved within set 1
    expect(updatedSet1ParentPlan.dependencies).toEqual([2, 3, 4]);
    expect(updatedSet1Plan1.dependencies).toEqual([]);
    expect(updatedSet1Plan2.dependencies).toEqual([2]);
    expect(updatedSet1Plan3.dependencies).toEqual([2, 3]);

    // Check that dependencies are updated correctly for set 2
    expect(updatedSet2ParentPlan.dependencies).toEqual([6, 7, 8]);
    expect(updatedSet2Plan1.dependencies).toEqual([]);
    expect(updatedSet2Plan2.dependencies).toEqual([6]);
    expect(updatedSet2Plan3.dependencies).toEqual([6, 7]);
  });

  test('prefers specified plans when resolving conflicts', async () => {
    // Create plans with conflicting IDs
    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();

    // Create two plans with the same ID 1
    await createPlan(1, 'Older plan - should be renumbered', '1-old.yml', oldTime);
    await createPlan(1, 'Newer plan - should keep ID', '1-new.yml', newTime);

    // Use --prefer to keep the newer plan (which would normally be renumbered)
    await handleRenumber({ prefer: ['1-new.yml'] }, createMockCommand());

    // Check that files were renamed correctly
    const files = await fs.promises.readdir(tasksDir);
    expect(files).toContain('1-new.yml'); // Kept its name
    expect(files).toContain('2-old.yml'); // Renamed

    // Check that IDs were updated correctly
    const newPlan = await readPlanFile(path.join(tasksDir, '1-new.yml'));
    expect(newPlan.id).toBe(1); // Newer plan keeps ID 1 due to preference
    expect(newPlan.title).toBe('Newer plan - should keep ID');

    const oldPlan = await readPlanFile(path.join(tasksDir, '2-old.yml'));
    expect(oldPlan.id).toBe(2); // Older plan gets renumbered despite being older
    expect(oldPlan.title).toBe('Older plan - should be renumbered');
  });

  test('prefers parent and its children when parent is specified', async () => {
    // Create a hierarchy with conflicts
    const parent = {
      id: 1,
      title: 'Parent Plan',
      goal: 'Parent goal',
      status: 'pending',
      priority: 'medium',
      createdAt: new Date('2024-01-02').toISOString(), // Newer
      tasks: [],
    };

    const child = {
      id: 2,
      title: 'Child Plan',
      goal: 'Child goal',
      status: 'pending',
      priority: 'medium',
      parent: 1,
      tasks: [],
    };

    const grandchild = {
      id: 3,
      title: 'Grandchild Plan',
      goal: 'Grandchild goal',
      status: 'pending',
      priority: 'medium',
      parent: 2,
      tasks: [],
    };

    const conflictingPlan = {
      id: 1,
      title: 'Conflicting Plan',
      goal: 'Should be renumbered',
      status: 'pending',
      priority: 'medium',
      createdAt: new Date('2024-01-01').toISOString(), // Older, would normally be kept
      tasks: [],
    };

    await writeTestPlan(path.join(tasksDir, '1-parent.yml'), parent);
    await writeTestPlan(path.join(tasksDir, '2-child.yml'), child);
    await writeTestPlan(path.join(tasksDir, '3-grandchild.yml'), grandchild);
    await writeTestPlan(path.join(tasksDir, '1-conflicting.yml'), conflictingPlan);

    // Prefer the parent, which should also protect its children
    await handleRenumber({ prefer: ['1-parent.yml'] }, createMockCommand());

    // Parent should keep ID 1
    const updatedParent = await readPlanFile(path.join(tasksDir, '1-parent.yml'));
    expect(updatedParent.id).toBe(1);

    // Child should keep ID 2 and parent reference should remain
    const updatedChild = await readPlanFile(path.join(tasksDir, '2-child.yml'));
    expect(updatedChild.id).toBe(2);
    expect(updatedChild.parent).toBe(1);

    // Grandchild should keep ID 3 and parent reference should remain
    const updatedGrandchild = await readPlanFile(path.join(tasksDir, '3-grandchild.yml'));
    expect(updatedGrandchild.id).toBe(3);
    expect(updatedGrandchild.parent).toBe(2);

    // Conflicting plan should be renumbered
    const updatedConflictingPath = path.join(tasksDir, '4-conflicting.yml');
    expect(fs.existsSync(updatedConflictingPath)).toBe(true);
    const updatedConflicting = await readPlanFile(updatedConflictingPath);
    expect(updatedConflicting.id).toBe(4);

    // Original conflicting file should be removed
    expect(fs.existsSync(path.join(tasksDir, '1-conflicting.yml'))).toBe(false);
  });

  test('handles multiple preferred files', async () => {
    // Create multiple sets of conflicting plans
    await createPlan(1, 'Plan A1', '1-a1.yml', new Date('2024-01-01').toISOString());
    await createPlan(1, 'Plan B1', '1-b1.yml', new Date('2024-01-02').toISOString());
    await createPlan(2, 'Plan A2', '2-a2.yml', new Date('2024-01-01').toISOString());
    await createPlan(2, 'Plan B2', '2-b2.yml', new Date('2024-01-02').toISOString());

    // Prefer the B plans (newer ones)
    await handleRenumber({ prefer: ['1-b1.yml', '2-b2.yml'] }, createMockCommand());

    // B plans should keep their IDs
    const b1 = await readPlanFile(path.join(tasksDir, '1-b1.yml'));
    expect(b1.id).toBe(1);

    const b2 = await readPlanFile(path.join(tasksDir, '2-b2.yml'));
    expect(b2.id).toBe(2);

    // A plans should be renumbered
    const a1 = await readPlanFile(path.join(tasksDir, '3-a1.yml'));
    expect(a1.id).toBe(3);

    const a2 = await readPlanFile(path.join(tasksDir, '4-a2.yml'));
    expect(a2.id).toBe(4);
  });

  test('handles absolute paths in --prefer option', async () => {
    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();

    await createPlan(1, 'Older plan', '1-old.yml', oldTime);
    await createPlan(1, 'Newer plan', '1-new.yml', newTime);

    // Use absolute path for preference
    const absolutePath = path.join(tasksDir, '1-new.yml');
    await handleRenumber({ prefer: [absolutePath] }, createMockCommand());

    // Newer plan should keep ID 1
    const newPlan = await readPlanFile(path.join(tasksDir, '1-new.yml'));
    expect(newPlan.id).toBe(1);

    // Older plan should be renumbered
    const oldPlan = await readPlanFile(path.join(tasksDir, '2-old.yml'));
    expect(oldPlan.id).toBe(2);
  });

  // Branch-aware renumber tests
  test('prefers plans changed on current feature branch when resolving conflicts', async () => {
    // Mock git functions to simulate being on a feature branch
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
      getCurrentBranchName: mock(async () => 'feature-branch'),
      getChangedFilesOnBranch: mock(async () => [path.join(tasksDir, '1-new.yml')]),
    }));

    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();

    // Create conflicting plans - the newer file is the one changed on the branch
    await createPlan(1, 'Older plan', '1-old.yml', oldTime);
    await createPlan(1, 'Newer plan - changed on branch', '1-new.yml', newTime);

    await handleRenumber({}, createMockCommand());

    // The newer plan (changed on branch) should keep ID 1 despite being newer
    const newPlan = await readPlanFile(path.join(tasksDir, '1-new.yml'));
    expect(newPlan.id).toBe(1);
    expect(newPlan.title).toBe('Newer plan - changed on branch');

    // The older plan should be renumbered to 2
    const oldPlan = await readPlanFile(path.join(tasksDir, '2-old.yml'));
    expect(oldPlan.id).toBe(2);
    expect(oldPlan.title).toBe('Older plan');
  });

  test('uses timestamp logic when on trunk branch (main)', async () => {
    // Mock git functions to simulate being on main branch
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
      getCurrentBranchName: mock(async () => 'main'),
      getChangedFilesOnBranch: mock(async () => []), // Not called when on trunk
    }));

    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();

    // Create conflicting plans
    await createPlan(1, 'Older plan', '1-old.yml', oldTime);
    await createPlan(1, 'Newer plan', '1-new.yml', newTime);

    await handleRenumber({}, createMockCommand());

    // Should use timestamp logic: older plan keeps ID 1
    const oldPlan = await readPlanFile(path.join(tasksDir, '1-old.yml'));
    expect(oldPlan.id).toBe(1);
    expect(oldPlan.title).toBe('Older plan');

    // Newer plan should be renumbered to 2
    const newPlan = await readPlanFile(path.join(tasksDir, '2-new.yml'));
    expect(newPlan.id).toBe(2);
    expect(newPlan.title).toBe('Newer plan');
  });

  test('prefer flag overrides branch-based preference', async () => {
    // Mock git functions to simulate being on a feature branch
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
      getCurrentBranchName: mock(async () => 'feature-branch'),
      getChangedFilesOnBranch: mock(async () => [path.join(tasksDir, '1-new.yml')]),
    }));

    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();

    // Create conflicting plans - the newer file is changed on branch
    await createPlan(1, 'Older plan', '1-old.yml', oldTime);
    await createPlan(1, 'Newer plan - changed on branch', '1-new.yml', newTime);

    // Use --prefer to override branch-based preference, preferring the older file
    await handleRenumber({ prefer: ['1-old.yml'] }, createMockCommand());

    // The older plan should keep ID 1 due to explicit preference
    const oldPlan = await readPlanFile(path.join(tasksDir, '1-old.yml'));
    expect(oldPlan.id).toBe(1);
    expect(oldPlan.title).toBe('Older plan');

    // The newer plan should be renumbered despite being changed on branch
    const newPlan = await readPlanFile(path.join(tasksDir, '2-new.yml'));
    expect(newPlan.id).toBe(2);
    expect(newPlan.title).toBe('Newer plan - changed on branch');
  });

  test('falls back to timestamp logic when no conflicting files were changed on branch', async () => {
    // Mock git functions to simulate being on a feature branch but no conflicting files changed
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
      getCurrentBranchName: mock(async () => 'feature-branch'),
      getChangedFilesOnBranch: mock(async () => [path.join(tasksDir, 'different-file.yml')]),
    }));

    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();

    // Create conflicting plans - neither file was changed on the branch
    await createPlan(1, 'Older plan', '1-old.yml', oldTime);
    await createPlan(1, 'Newer plan', '1-new.yml', newTime);

    await handleRenumber({}, createMockCommand());

    // Should fall back to timestamp logic: older plan keeps ID 1
    const oldPlan = await readPlanFile(path.join(tasksDir, '1-old.yml'));
    expect(oldPlan.id).toBe(1);
    expect(oldPlan.title).toBe('Older plan');

    // Newer plan should be renumbered to 2
    const newPlan = await readPlanFile(path.join(tasksDir, '2-new.yml'));
    expect(newPlan.id).toBe(2);
    expect(newPlan.title).toBe('Newer plan');
  });

  test('handles errors when Git operations fail', async () => {
    // Mock git functions where getChangedFilesOnBranch throws an error
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
      getCurrentBranchName: mock(async () => 'feature-branch'),
      getChangedFilesOnBranch: mock(async () => {
        throw new Error('Git operation failed');
      }),
    }));

    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();

    // Create conflicting plans
    await createPlan(1, 'Older plan', '1-old.yml', oldTime);
    await createPlan(1, 'Newer plan', '1-new.yml', newTime);

    // Should not throw and fall back to timestamp logic
    await handleRenumber({}, createMockCommand());

    // Should fall back to timestamp logic: older plan keeps ID 1
    const oldPlan = await readPlanFile(path.join(tasksDir, '1-old.yml'));
    expect(oldPlan.id).toBe(1);
    expect(oldPlan.title).toBe('Older plan');

    // Newer plan should be renumbered to 2
    const newPlan = await readPlanFile(path.join(tasksDir, '2-new.yml'));
    expect(newPlan.id).toBe(2);
    expect(newPlan.title).toBe('Newer plan');
  });
});
