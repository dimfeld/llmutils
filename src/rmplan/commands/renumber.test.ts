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

  test('keeps specified plans when resolving conflicts', async () => {
    // Create plans with conflicting IDs
    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();

    // Create two plans with the same ID 1
    await createPlan(1, 'Older plan - should be renumbered', '1-old.yml', oldTime);
    await createPlan(1, 'Newer plan - should keep ID', '1-new.yml', newTime);

    // Use --keep to keep the newer plan (which would normally be renumbered)
    await handleRenumber({ keep: ['1-new.yml'] }, createMockCommand());

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

  test('keeps parent and its children when parent is specified', async () => {
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
    await handleRenumber({ keep: ['1-parent.yml'] }, createMockCommand());

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

  test('handles multiple keep files', async () => {
    // Create multiple sets of conflicting plans
    await createPlan(1, 'Plan A1', '1-a1.yml', new Date('2024-01-01').toISOString());
    await createPlan(1, 'Plan B1', '1-b1.yml', new Date('2024-01-02').toISOString());
    await createPlan(2, 'Plan A2', '2-a2.yml', new Date('2024-01-01').toISOString());
    await createPlan(2, 'Plan B2', '2-b2.yml', new Date('2024-01-02').toISOString());

    // Prefer the B plans (newer ones)
    await handleRenumber({ keep: ['1-b1.yml', '2-b2.yml'] }, createMockCommand());

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

  test('handles absolute paths in --keep option', async () => {
    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();

    await createPlan(1, 'Older plan', '1-old.yml', oldTime);
    await createPlan(1, 'Newer plan', '1-new.yml', newTime);

    // Use absolute path for preference
    const absolutePath = path.join(tasksDir, '1-new.yml');
    await handleRenumber({ keep: [absolutePath] }, createMockCommand());

    // Newer plan should keep ID 1
    const newPlan = await readPlanFile(path.join(tasksDir, '1-new.yml'));
    expect(newPlan.id).toBe(1);

    // Older plan should be renumbered
    const oldPlan = await readPlanFile(path.join(tasksDir, '2-old.yml'));
    expect(oldPlan.id).toBe(2);
  });

  // Branch-aware renumber tests
  test('renumbers plans changed on current feature branch when resolving conflicts', async () => {
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

    // The older plan (unchanged on branch) should keep ID 1
    const oldPlan = await readPlanFile(path.join(tasksDir, '1-old.yml'));
    expect(oldPlan.id).toBe(1);
    expect(oldPlan.title).toBe('Older plan');

    // The newer plan (changed on branch) should be renumbered to 2
    const newPlan = await readPlanFile(path.join(tasksDir, '2-new.yml'));
    expect(newPlan.id).toBe(2);
    expect(newPlan.title).toBe('Newer plan - changed on branch');
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

  test('keep flag overrides branch-based preference', async () => {
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

    // Use --keep to override branch-based preference, keeping the changed file
    await handleRenumber({ keep: ['1-new.yml'] }, createMockCommand());

    // The newer plan should keep ID 1 due to explicit preference, even though it would normally be renumbered
    const newPlan = await readPlanFile(path.join(tasksDir, '1-new.yml'));
    expect(newPlan.id).toBe(1);
    expect(newPlan.title).toBe('Newer plan - changed on branch');

    // The older plan should be renumbered
    const oldPlan = await readPlanFile(path.join(tasksDir, '2-old.yml'));
    expect(oldPlan.id).toBe(2);
    expect(oldPlan.title).toBe('Older plan');
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

  test('handles mixed scenario where some files are changed on branch and others are not', async () => {
    // Mock git functions to simulate being on a feature branch
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
      getCurrentBranchName: mock(async () => 'feature-branch'),
      getChangedFilesOnBranch: mock(async () => [
        path.join(tasksDir, '1-changed.yml'), // This one was changed on branch
        // '1-unchanged.yml' was not changed on branch
      ]),
    }));

    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();
    const middleTime = new Date('2024-03-01').toISOString();

    // Create three conflicting plans with ID 1
    await createPlan(1, 'Unchanged plan - oldest', '1-unchanged.yml', oldTime);
    await createPlan(1, 'Changed plan - newer', '1-changed.yml', newTime);
    await createPlan(1, 'Another unchanged plan - middle time', '1-unchanged2.yml', middleTime);

    await handleRenumber({}, createMockCommand());

    // The oldest unchanged plan should keep ID 1
    const unchangedPlan = await readPlanFile(path.join(tasksDir, '1-unchanged.yml'));
    expect(unchangedPlan.id).toBe(1);
    expect(unchangedPlan.title).toBe('Unchanged plan - oldest');

    // The changed plan should be renumbered (even though it's newer)
    const changedPlan = await readPlanFile(path.join(tasksDir, '2-changed.yml'));
    expect(changedPlan.id).toBe(2);
    expect(changedPlan.title).toBe('Changed plan - newer');

    // The other unchanged plan should also be renumbered (not the oldest unchanged)
    const unchanged2Plan = await readPlanFile(path.join(tasksDir, '3-unchanged2.yml'));
    expect(unchanged2Plan.id).toBe(3);
    expect(unchanged2Plan.title).toBe('Another unchanged plan - middle time');
  });

  test('handles case where all conflicting files are changed on the branch', async () => {
    // Mock git functions to simulate being on a feature branch
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
      getCurrentBranchName: mock(async () => 'feature-branch'),
      getChangedFilesOnBranch: mock(async () => [
        path.join(tasksDir, '1-changed-old.yml'),
        path.join(tasksDir, '1-changed-new.yml'),
        path.join(tasksDir, '1-changed-newest.yml'),
      ]),
    }));

    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();
    const newestTime = new Date('2024-12-01').toISOString();

    // Create three conflicting plans with ID 1, all changed on branch
    await createPlan(1, 'Changed plan - oldest', '1-changed-old.yml', oldTime);
    await createPlan(1, 'Changed plan - newer', '1-changed-new.yml', newTime);
    await createPlan(1, 'Changed plan - newest', '1-changed-newest.yml', newestTime);

    await handleRenumber({}, createMockCommand());

    // When all files are changed on branch, should fall back to timestamp logic
    // The oldest should keep ID 1
    const oldPlan = await readPlanFile(path.join(tasksDir, '1-changed-old.yml'));
    expect(oldPlan.id).toBe(1);
    expect(oldPlan.title).toBe('Changed plan - oldest');

    // The other two should be renumbered
    const newPlan = await readPlanFile(path.join(tasksDir, '2-changed-new.yml'));
    expect(newPlan.id).toBe(2);
    expect(newPlan.title).toBe('Changed plan - newer');

    const newestPlan = await readPlanFile(path.join(tasksDir, '3-changed-newest.yml'));
    expect(newestPlan.id).toBe(3);
    expect(newestPlan.title).toBe('Changed plan - newest');
  });

  test('handles complex dependency updates with multiple conflict sets and branch logic', async () => {
    // Mock git functions to simulate being on a feature branch
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
      getCurrentBranchName: mock(async () => 'feature-branch'),
      getChangedFilesOnBranch: mock(async () => [
        path.join(tasksDir, '1-changed.yml'), // ID 1 conflict - changed
        path.join(tasksDir, '3-changed.yml'), // ID 3 conflict - changed
      ]),
    }));

    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();

    // Create first conflict set (ID 1)
    const plan1Unchanged: PlanSchema = {
      id: 1,
      title: 'Plan 1 Unchanged',
      goal: 'Goal 1',
      details: 'Details 1',
      status: 'pending',
      priority: 'medium',
      dependencies: [3], // Depends on ID 3 which will also have conflicts
      createdAt: oldTime,
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    const plan1Changed: PlanSchema = {
      id: 1,
      title: 'Plan 1 Changed',
      goal: 'Goal 1 updated',
      details: 'Details 1 updated',
      status: 'pending',
      priority: 'medium',
      dependencies: [3], // Same dependency
      createdAt: newTime,
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    // Create second conflict set (ID 3)
    const plan3Unchanged: PlanSchema = {
      id: 3,
      title: 'Plan 3 Unchanged',
      goal: 'Goal 3',
      details: 'Details 3',
      status: 'pending',
      priority: 'medium',
      dependencies: [],
      createdAt: oldTime,
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    const plan3Changed: PlanSchema = {
      id: 3,
      title: 'Plan 3 Changed',
      goal: 'Goal 3 updated',
      details: 'Details 3 updated',
      status: 'pending',
      priority: 'medium',
      dependencies: [],
      createdAt: newTime,
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    await writeTestPlan(path.join(tasksDir, '1-unchanged.yml'), plan1Unchanged);
    await writeTestPlan(path.join(tasksDir, '1-changed.yml'), plan1Changed);
    await writeTestPlan(path.join(tasksDir, '3-unchanged.yml'), plan3Unchanged);
    await writeTestPlan(path.join(tasksDir, '3-changed.yml'), plan3Changed);

    await handleRenumber({}, createMockCommand());

    // Unchanged files should keep their original IDs
    const unchangedPlan1 = await readPlanFile(path.join(tasksDir, '1-unchanged.yml'));
    expect(unchangedPlan1.id).toBe(1);
    expect(unchangedPlan1.dependencies).toEqual([3]); // Should still point to unchanged plan 3

    const unchangedPlan3 = await readPlanFile(path.join(tasksDir, '3-unchanged.yml'));
    expect(unchangedPlan3.id).toBe(3);

    // Changed files should be renumbered to higher IDs
    const changedPlan1 = await readPlanFile(path.join(tasksDir, '4-changed.yml'));
    expect(changedPlan1.id).toBe(4);
    expect(changedPlan1.dependencies).toEqual([5]); // Should point to the renumbered plan 3

    const changedPlan3 = await readPlanFile(path.join(tasksDir, '5-changed.yml'));
    expect(changedPlan3.id).toBe(5);
  });

  test('keep flag overrides branch logic with multiple conflict sets', async () => {
    // Mock git functions to simulate being on a feature branch
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
      getCurrentBranchName: mock(async () => 'feature-branch'),
      getChangedFilesOnBranch: mock(async () => [
        path.join(tasksDir, '1-changed.yml'),
        path.join(tasksDir, '2-changed.yml'),
      ]),
    }));

    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();

    // Create two sets of conflicts
    await createPlan(1, 'Plan 1 Unchanged', '1-unchanged.yml', oldTime);
    await createPlan(1, 'Plan 1 Changed - should keep via flag', '1-changed.yml', newTime);
    await createPlan(2, 'Plan 2 Unchanged', '2-unchanged.yml', oldTime);
    await createPlan(2, 'Plan 2 Changed - should be renumbered', '2-changed.yml', newTime);

    // Use keep flag to prefer one of the changed files
    await handleRenumber({ keep: ['1-changed.yml'] }, createMockCommand());

    // The preferred changed file should keep its ID despite being changed on branch
    const changedPlan1 = await readPlanFile(path.join(tasksDir, '1-changed.yml'));
    expect(changedPlan1.id).toBe(1);
    expect(changedPlan1.title).toBe('Plan 1 Changed - should keep via flag');

    // The unchanged file should be renumbered
    const unchangedPlan1 = await readPlanFile(path.join(tasksDir, '3-unchanged.yml'));
    expect(unchangedPlan1.id).toBe(3);

    // For the second conflict, branch logic should apply normally
    // Unchanged file keeps ID 2, changed file gets renumbered
    const unchangedPlan2 = await readPlanFile(path.join(tasksDir, '2-unchanged.yml'));
    expect(unchangedPlan2.id).toBe(2);

    const changedPlan2 = await readPlanFile(path.join(tasksDir, '4-changed.yml'));
    expect(changedPlan2.id).toBe(4);
  });

  test('handles large number of changed files efficiently when no conflicts exist', async () => {
    // Mock git functions to simulate being on a feature branch with many changed files
    const changedFiles = [];
    for (let i = 1; i <= 50; i++) {
      changedFiles.push(path.join(tasksDir, `${i}.yml`));
    }

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
      getCurrentBranchName: mock(async () => 'feature-branch'),
      getChangedFilesOnBranch: mock(async () => changedFiles),
    }));

    // Create many non-conflicting plans (all with unique IDs)
    for (let i = 1; i <= 50; i++) {
      await createPlan(i, `Plan ${i}`, `${i}.yml`, new Date().toISOString());
    }

    const startTime = Date.now();
    await handleRenumber({}, createMockCommand());
    const endTime = Date.now();

    // Should complete quickly (within 2 seconds for 50 plans with no conflicts)
    expect(endTime - startTime).toBeLessThan(2000);

    // Verify no files were changed (no conflicts to resolve)
    for (let i = 1; i <= 50; i++) {
      const plan = await readPlanFile(path.join(tasksDir, `${i}.yml`));
      expect(plan.id).toBe(i);
      expect(plan.title).toBe(`Plan ${i}`);
    }
  });

  test('hierarchy helper functions work correctly', async () => {
    // Create a simple hierarchy: parent (ID 10) -> child (ID 5)
    // This is disordered since parent ID > child ID
    await createPlan(10, 'Parent Plan', '10-parent.yml');

    const childPlan: PlanSchema = {
      id: 5,
      title: 'Child Plan',
      goal: 'Child goal',
      details: 'Child details',
      status: 'pending',
      priority: 'medium',
      parent: 10, // Parent relationship
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '5-child.yml'), yaml.stringify(childPlan));

    // Create a grandchild (ID 3) -> depends on child (ID 5)
    const grandchildPlan: PlanSchema = {
      id: 3,
      title: 'Grandchild Plan',
      goal: 'Grandchild goal',
      details: 'Grandchild details',
      status: 'pending',
      priority: 'medium',
      parent: 5, // Parent is the child
      dependencies: [5], // Also has explicit dependency
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '3-grandchild.yml'), yaml.stringify(grandchildPlan));

    // Mock the imported functions to test them independently
    const {
      buildParentChildHierarchy,
      findRootParent,
      findPlanFamily,
      findDisorderedFamilies,
      topologicalSortFamily,
    } = await import('./renumber.js');

    // Build allPlans map
    const allPlans = new Map();
    const parentPlan = await readPlanFile(path.join(tasksDir, '10-parent.yml'));
    const child = await readPlanFile(path.join(tasksDir, '5-child.yml'));
    const grandchild = await readPlanFile(path.join(tasksDir, '3-grandchild.yml'));

    allPlans.set(path.join(tasksDir, '10-parent.yml'), parentPlan);
    allPlans.set(path.join(tasksDir, '5-child.yml'), child);
    allPlans.set(path.join(tasksDir, '3-grandchild.yml'), grandchild);

    // Test buildParentChildHierarchy
    const hierarchy = buildParentChildHierarchy(allPlans);
    expect(hierarchy.has(10)).toBe(true); // Parent 10 should have children
    expect(hierarchy.has(5)).toBe(true); // Child 5 should have children (grandchild 3)
    expect(hierarchy.get(10)!.length).toBe(1); // Parent should have 1 child
    expect(hierarchy.get(5)!.length).toBe(1); // Child should have 1 child (grandchild)
    expect(hierarchy.get(10)![0].plan.id).toBe(5); // Parent's child should be plan 5
    expect(hierarchy.get(5)![0].plan.id).toBe(3); // Child's child should be plan 3

    // Test findRootParent
    expect(findRootParent(3, allPlans)).toBe(10); // Grandchild's root should be 10
    expect(findRootParent(5, allPlans)).toBe(10); // Child's root should be 10
    expect(findRootParent(10, allPlans)).toBe(10); // Parent's root should be itself

    // Test findPlanFamily
    const family = findPlanFamily(10, allPlans, hierarchy);
    expect(family.length).toBe(3); // Should find all 3 plans in the family
    const familyIds = family.map((f) => f.plan.id).sort((a, b) => a - b);
    expect(familyIds).toEqual([3, 5, 10]); // Should contain all family members

    // Test findDisorderedFamilies
    const disorderedRoots = findDisorderedFamilies(allPlans, hierarchy);
    expect(disorderedRoots.has(10)).toBe(true); // Root 10 should be identified as disordered

    // Test topologicalSortFamily
    const sortedFamily = topologicalSortFamily(family);
    expect(sortedFamily.length).toBe(3);

    // Verify topological order: parent (10) should come before child (5) and grandchild (3)
    // Child (5) should come before grandchild (3)
    const sortedIds = sortedFamily.map((f) => f.plan.id);
    const parentIndex = sortedIds.indexOf(10);
    const childIndex = sortedIds.indexOf(5);
    const grandchildIndex = sortedIds.indexOf(3);

    expect(parentIndex).toBeLessThan(childIndex); // Parent before child
    expect(childIndex).toBeLessThan(grandchildIndex); // Child before grandchild
  });

  test('single-plan family (no children) - helper functions', async () => {
    // Create a standalone plan with no children or parent
    await createPlan(42, 'Standalone Plan', '42-standalone.yml');

    const { buildParentChildHierarchy, findRootParent, findPlanFamily, findDisorderedFamilies } =
      await import('./renumber.js');

    const allPlans = new Map();
    const standalonePlan = await readPlanFile(path.join(tasksDir, '42-standalone.yml'));
    allPlans.set(path.join(tasksDir, '42-standalone.yml'), standalonePlan);

    // Test buildParentChildHierarchy - should have no entries for this plan
    const hierarchy = buildParentChildHierarchy(allPlans);
    expect(hierarchy.has(42)).toBe(false); // No children, so no entry

    // Test findRootParent - plan should be its own root
    expect(findRootParent(42, allPlans)).toBe(42);

    // Test findPlanFamily - should return just the plan itself
    const family = findPlanFamily(42, allPlans, hierarchy);
    expect(family.length).toBe(1);
    expect(family[0].plan.id).toBe(42);

    // Test findDisorderedFamilies - should not identify this as disordered
    const disorderedRoots = findDisorderedFamilies(allPlans, hierarchy);
    expect(disorderedRoots.has(42)).toBe(false);
  });

  test('complex multi-level hierarchy (4+ levels) - helper functions', async () => {
    // Create a 4-level hierarchy with disorder: great-grandparent (20) -> grandparent (15) -> parent (10) -> child (5)
    await createPlan(20, 'Great-Grandparent Plan', '20-great-grandparent.yml');

    const grandparentPlan: PlanSchema = {
      id: 15,
      title: 'Grandparent Plan',
      goal: 'Grandparent goal',
      details: 'Grandparent details',
      status: 'pending',
      priority: 'medium',
      parent: 20,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '15-grandparent.yml'), yaml.stringify(grandparentPlan));

    const parentPlan: PlanSchema = {
      id: 10,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'pending',
      priority: 'medium',
      parent: 15,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '10-parent.yml'), yaml.stringify(parentPlan));

    const childPlan: PlanSchema = {
      id: 5,
      title: 'Child Plan',
      goal: 'Child goal',
      details: 'Child details',
      status: 'pending',
      priority: 'medium',
      parent: 10,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '5-child.yml'), yaml.stringify(childPlan));

    const {
      buildParentChildHierarchy,
      findRootParent,
      findPlanFamily,
      findDisorderedFamilies,
      topologicalSortFamily,
    } = await import('./renumber.js');

    const allPlans = new Map();
    const greatGrandparent = await readPlanFile(path.join(tasksDir, '20-great-grandparent.yml'));
    const grandparent = await readPlanFile(path.join(tasksDir, '15-grandparent.yml'));
    const parent = await readPlanFile(path.join(tasksDir, '10-parent.yml'));
    const child = await readPlanFile(path.join(tasksDir, '5-child.yml'));

    allPlans.set(path.join(tasksDir, '20-great-grandparent.yml'), greatGrandparent);
    allPlans.set(path.join(tasksDir, '15-grandparent.yml'), grandparent);
    allPlans.set(path.join(tasksDir, '10-parent.yml'), parent);
    allPlans.set(path.join(tasksDir, '5-child.yml'), child);

    // Test buildParentChildHierarchy - should build 3 levels of parent-child relationships
    const hierarchy = buildParentChildHierarchy(allPlans);
    expect(hierarchy.has(20)).toBe(true); // Great-grandparent should have children
    expect(hierarchy.has(15)).toBe(true); // Grandparent should have children
    expect(hierarchy.has(10)).toBe(true); // Parent should have children
    expect(hierarchy.has(5)).toBe(false); // Child should have no children

    // Test findRootParent - all should trace back to great-grandparent (20)
    expect(findRootParent(5, allPlans)).toBe(20);
    expect(findRootParent(10, allPlans)).toBe(20);
    expect(findRootParent(15, allPlans)).toBe(20);
    expect(findRootParent(20, allPlans)).toBe(20);

    // Test findPlanFamily - should find all 4 plans
    const family = findPlanFamily(20, allPlans, hierarchy);
    expect(family.length).toBe(4);
    const familyIds = family.map((f) => f.plan.id).sort((a, b) => a - b);
    expect(familyIds).toEqual([5, 10, 15, 20]);

    // Test findDisorderedFamilies - should identify the root as disordered
    const disorderedRoots = findDisorderedFamilies(allPlans, hierarchy);
    expect(disorderedRoots.has(20)).toBe(true);

    // Test topologicalSortFamily - should maintain hierarchy order
    const sortedFamily = topologicalSortFamily(family);
    expect(sortedFamily.length).toBe(4);

    const sortedIds = sortedFamily.map((f) => f.plan.id);
    const greatGrandparentIndex = sortedIds.indexOf(20);
    const grandparentIndex = sortedIds.indexOf(15);
    const parentIndex = sortedIds.indexOf(10);
    const childIndex = sortedIds.indexOf(5);

    expect(greatGrandparentIndex).toBeLessThan(grandparentIndex);
    expect(grandparentIndex).toBeLessThan(parentIndex);
    expect(parentIndex).toBeLessThan(childIndex);
  });

  test('plans with missing parent references - helper functions', async () => {
    // Create a child that references a non-existent parent
    const orphanPlan: PlanSchema = {
      id: 10,
      title: 'Orphan Plan',
      goal: 'Orphan goal',
      details: 'Orphan details',
      status: 'pending',
      priority: 'medium',
      parent: 999, // Non-existent parent
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '10-orphan.yml'), yaml.stringify(orphanPlan));

    const { buildParentChildHierarchy, findRootParent, findPlanFamily, findDisorderedFamilies } =
      await import('./renumber.js');

    const allPlans = new Map();
    const orphan = await readPlanFile(path.join(tasksDir, '10-orphan.yml'));
    allPlans.set(path.join(tasksDir, '10-orphan.yml'), orphan);

    // Test buildParentChildHierarchy - should NOT create entry for missing parent (only validates existing parents)
    const hierarchy = buildParentChildHierarchy(allPlans);
    expect(hierarchy.has(999)).toBe(false); // No entry created for missing parent 999
    expect(hierarchy.has(10)).toBe(false); // Orphan plan has no children either

    // Test findRootParent - should not follow chain to missing parent, returns the orphan plan itself
    expect(findRootParent(10, allPlans)).toBe(10); // Returns the orphan plan ID since parent doesn't exist

    // Test findPlanFamily - should return just the orphan plan (since it has no valid parent)
    const family = findPlanFamily(10, allPlans, hierarchy);
    expect(family.length).toBe(1);
    expect(family[0].plan.id).toBe(10);

    // Test findDisorderedFamilies - should not identify as disordered (single plan family)
    const disorderedRoots = findDisorderedFamilies(allPlans, hierarchy);
    expect(disorderedRoots.has(10)).toBe(false);
  });

  test('plans with empty dependency arrays - helper functions', async () => {
    // Create parent with empty dependencies array
    const parentPlan: PlanSchema = {
      id: 10,
      title: 'Parent with Empty Dependencies',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'pending',
      priority: 'medium',
      dependencies: [], // Explicitly empty
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '10-parent.yml'), yaml.stringify(parentPlan));

    const childPlan: PlanSchema = {
      id: 5,
      title: 'Child with Empty Dependencies',
      goal: 'Child goal',
      details: 'Child details',
      status: 'pending',
      priority: 'medium',
      parent: 10,
      dependencies: [], // Explicitly empty
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '5-child.yml'), yaml.stringify(childPlan));

    const {
      buildParentChildHierarchy,
      findPlanFamily,
      findDisorderedFamilies,
      topologicalSortFamily,
    } = await import('./renumber.js');

    const allPlans = new Map();
    const parent = await readPlanFile(path.join(tasksDir, '10-parent.yml'));
    const child = await readPlanFile(path.join(tasksDir, '5-child.yml'));

    allPlans.set(path.join(tasksDir, '10-parent.yml'), parent);
    allPlans.set(path.join(tasksDir, '5-child.yml'), child);

    const hierarchy = buildParentChildHierarchy(allPlans);
    const family = findPlanFamily(10, allPlans, hierarchy);
    const disorderedRoots = findDisorderedFamilies(allPlans, hierarchy);

    // Should still identify as disordered family (parent ID 10 > child ID 5)
    expect(disorderedRoots.has(10)).toBe(true);

    // Test topologicalSortFamily with empty dependencies - should still respect parent-child order
    const sortedFamily = topologicalSortFamily(family);
    expect(sortedFamily.length).toBe(2);

    const sortedIds = sortedFamily.map((f) => f.plan.id);
    const parentIndex = sortedIds.indexOf(10);
    const childIndex = sortedIds.indexOf(5);

    expect(parentIndex).toBeLessThan(childIndex); // Parent should still come before child
  });

  test('complex sibling dependency chains - helper functions', async () => {
    // Create parent with 3 children having complex dependency chain
    await createPlan(15, 'Parent Plan', '15-parent.yml');

    const child1Plan: PlanSchema = {
      id: 5,
      title: 'Child 1 - No dependencies',
      goal: 'Child 1 goal',
      details: 'Child 1 details',
      status: 'pending',
      priority: 'medium',
      parent: 15,
      dependencies: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '5-child1.yml'), yaml.stringify(child1Plan));

    const child2Plan: PlanSchema = {
      id: 8,
      title: 'Child 2 - Depends on Child 1',
      goal: 'Child 2 goal',
      details: 'Child 2 details',
      status: 'pending',
      priority: 'medium',
      parent: 15,
      dependencies: [5], // Depends on child 1
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '8-child2.yml'), yaml.stringify(child2Plan));

    const child3Plan: PlanSchema = {
      id: 12,
      title: 'Child 3 - Depends on Child 1 and 2',
      goal: 'Child 3 goal',
      details: 'Child 3 details',
      status: 'pending',
      priority: 'medium',
      parent: 15,
      dependencies: [5, 8], // Depends on both child 1 and child 2
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '12-child3.yml'), yaml.stringify(child3Plan));

    const {
      buildParentChildHierarchy,
      findPlanFamily,
      findDisorderedFamilies,
      topologicalSortFamily,
    } = await import('./renumber.js');

    const allPlans = new Map();
    const parent = await readPlanFile(path.join(tasksDir, '15-parent.yml'));
    const child1 = await readPlanFile(path.join(tasksDir, '5-child1.yml'));
    const child2 = await readPlanFile(path.join(tasksDir, '8-child2.yml'));
    const child3 = await readPlanFile(path.join(tasksDir, '12-child3.yml'));

    allPlans.set(path.join(tasksDir, '15-parent.yml'), parent);
    allPlans.set(path.join(tasksDir, '5-child1.yml'), child1);
    allPlans.set(path.join(tasksDir, '8-child2.yml'), child2);
    allPlans.set(path.join(tasksDir, '12-child3.yml'), child3);

    const hierarchy = buildParentChildHierarchy(allPlans);
    const family = findPlanFamily(15, allPlans, hierarchy);
    const disorderedRoots = findDisorderedFamilies(allPlans, hierarchy);

    // Should identify as disordered family (parent ID 15 > some child IDs)
    expect(disorderedRoots.has(15)).toBe(true);

    // Test topological sort - should respect both parent-child and sibling dependencies
    const sortedFamily = topologicalSortFamily(family);
    expect(sortedFamily.length).toBe(4);

    const sortedIds = sortedFamily.map((f) => f.plan.id);
    const parentIndex = sortedIds.indexOf(15);
    const child1Index = sortedIds.indexOf(5);
    const child2Index = sortedIds.indexOf(8);
    const child3Index = sortedIds.indexOf(12);

    // Parent should come first
    expect(parentIndex).toBeLessThan(child1Index);
    expect(parentIndex).toBeLessThan(child2Index);
    expect(parentIndex).toBeLessThan(child3Index);

    // Child 1 should come before child 2 (child 2 depends on child 1)
    expect(child1Index).toBeLessThan(child2Index);

    // Child 1 and 2 should both come before child 3 (child 3 depends on both)
    expect(child1Index).toBeLessThan(child3Index);
    expect(child2Index).toBeLessThan(child3Index);
  });

  test('reassignFamilyIds function with various family sizes', async () => {
    const { reassignFamilyIds } = await import('./renumber.js');

    // Test single plan family (should return empty mapping)
    const singleFamily = [{ plan: { id: 42, title: 'Single Plan' }, filePath: '/path/to/42.yml' }];
    const singleMapping = reassignFamilyIds(singleFamily);
    expect(singleMapping.size).toBe(0);

    // Test two-plan family (parent-child swap)
    const twoFamily = [
      { plan: { id: 10, title: 'Parent' }, filePath: '/path/to/parent.yml' },
      { plan: { id: 5, title: 'Child' }, filePath: '/path/to/child.yml' },
    ];
    const twoMapping = reassignFamilyIds(twoFamily);
    expect(Array.from(twoMapping.entries())).toEqual([
      [10, 5],
      [5, 10],
    ]);

    // Test three-plan family with complex IDs
    const threeFamily = [
      { plan: { id: 20, title: 'Root' }, filePath: '/path/to/root.yml' },
      { plan: { id: 10, title: 'Middle' }, filePath: '/path/to/middle.yml' },
      { plan: { id: 5, title: 'Leaf' }, filePath: '/path/to/leaf.yml' },
    ];
    const threeMapping = reassignFamilyIds(threeFamily);
    expect(Array.from(threeMapping.entries())).toEqual([
      [20, 5],
      [10, 10],
      [5, 20],
    ]);

    // Test that existing IDs are reused in sorted order
    const unorderedFamily = [
      { plan: { id: 100, title: 'First in topological order' }, filePath: '/path/to/a.yml' },
      { plan: { id: 15, title: 'Second in topological order' }, filePath: '/path/to/b.yml' },
      { plan: { id: 3, title: 'Third in topological order' }, filePath: '/path/to/c.yml' },
      { plan: { id: 42, title: 'Fourth in topological order' }, filePath: '/path/to/d.yml' },
    ];
    const unorderedMapping = reassignFamilyIds(unorderedFamily);
    // Should assign sorted IDs [3, 15, 42, 100] to plans in topological order
    expect(Array.from(unorderedMapping.entries())).toEqual([
      [100, 3], // First plan gets lowest ID
      [15, 15], // Second plan gets second lowest ID
      [3, 42], // Third plan gets third lowest ID
      [42, 100], // Fourth plan gets highest ID
    ]);
  });

  test('cycle detection in topological sort', async () => {
    // Create a cycle: child1 depends on child2, child2 depends on child1
    await createPlan(10, 'Parent Plan', '10-parent.yml');

    const child1Plan: PlanSchema = {
      id: 5,
      title: 'Child 1',
      goal: 'Child 1 goal',
      details: 'Child 1 details',
      status: 'pending',
      priority: 'medium',
      parent: 10,
      dependencies: [8], // Depends on child 2
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '5-child1.yml'), yaml.stringify(child1Plan));

    const child2Plan: PlanSchema = {
      id: 8,
      title: 'Child 2',
      goal: 'Child 2 goal',
      details: 'Child 2 details',
      status: 'pending',
      priority: 'medium',
      parent: 10,
      dependencies: [5], // Depends on child 1 - creates cycle!
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '8-child2.yml'), yaml.stringify(child2Plan));

    const { buildParentChildHierarchy, findPlanFamily, topologicalSortFamily } = await import(
      './renumber.js'
    );

    const allPlans = new Map();
    const parent = await readPlanFile(path.join(tasksDir, '10-parent.yml'));
    const child1 = await readPlanFile(path.join(tasksDir, '5-child1.yml'));
    const child2 = await readPlanFile(path.join(tasksDir, '8-child2.yml'));

    allPlans.set(path.join(tasksDir, '10-parent.yml'), parent);
    allPlans.set(path.join(tasksDir, '5-child1.yml'), child1);
    allPlans.set(path.join(tasksDir, '8-child2.yml'), child2);

    const hierarchy = buildParentChildHierarchy(allPlans);
    const family = findPlanFamily(10, allPlans, hierarchy);

    // Test that topologicalSortFamily throws an error for circular dependencies
    expect(() => {
      topologicalSortFamily(family);
    }).toThrow(/circular dependency/i);
  });

  // End-to-end integration tests for hierarchical renumbering
  // These tests verify the complete workflow from Tasks 4-6

  test('debug hierarchical detection on simple case', async () => {
    // Create a disordered hierarchy: parent ID 10 has child with ID 5
    await createPlan(10, 'Parent Plan', '10-parent.yml');

    const childPlan: PlanSchema = {
      id: 5,
      title: 'Child Plan',
      goal: 'Child goal',
      details: 'Child details',
      status: 'pending',
      priority: 'medium',
      parent: 10, // Parent relationship creates hierarchical disorder
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '5-child.yml'), yaml.stringify(childPlan));

    // Import the hierarchical helper functions
    const {
      buildParentChildHierarchy,
      findDisorderedFamilies,
      findPlanFamily,
      topologicalSortFamily,
      reassignFamilyIds,
    } = await import('./renumber.js');

    // Build allPlans map just like in the real code
    const allPlans = new Map<string, Record<string, any>>();
    const parentPlan = await readPlanFile(path.join(tasksDir, '10-parent.yml'));
    const child = await readPlanFile(path.join(tasksDir, '5-child.yml'));

    allPlans.set(path.join(tasksDir, '10-parent.yml'), parentPlan);
    allPlans.set(path.join(tasksDir, '5-child.yml'), child);

    // Test the hierarchical detection pipeline step by step
    const hierarchy = buildParentChildHierarchy(allPlans);
    const disorderedRoots = findDisorderedFamilies(allPlans, hierarchy);

    if (disorderedRoots.size > 0) {
      const rootId = Array.from(disorderedRoots)[0];
      const family = findPlanFamily(rootId, allPlans, hierarchy);
      const sortedFamily = topologicalSortFamily(family);
      const idMappings = reassignFamilyIds(sortedFamily);

      // Verify the ID mappings are correct
      expect(Array.from(idMappings.entries())).toEqual([
        [10, 5],
        [5, 10],
      ]);
    }

    // The hierarchy should detect this as a disordered family
    expect(disorderedRoots.size).toBe(1);
    expect(disorderedRoots.has(10)).toBe(true);
  });

  test('end-to-end hierarchical renumbering with parent-child inversion', async () => {
    // Create a disordered hierarchy: parent ID 10 has child with ID 5
    await createPlan(10, 'Parent Plan', '10-parent.yml');

    const childPlan: PlanSchema = {
      id: 5,
      title: 'Child Plan',
      goal: 'Child goal',
      details: 'Child details',
      status: 'pending',
      priority: 'medium',
      parent: 10, // Parent relationship creates hierarchical disorder
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '5-child.yml'), yaml.stringify(childPlan));

    // Run hierarchical renumbering
    await handleRenumber({}, createMockCommand());

    // Verify the hierarchical renumbering worked correctly
    const files = await fs.promises.readdir(tasksDir);
    const parentPlanAfter = await readPlanFile(path.join(tasksDir, '5-parent.yml'));
    const childPlanAfter = await readPlanFile(path.join(tasksDir, '10-child.yml'));

    // After renumbering, parent should have lower ID than child
    // The IDs should be swapped: parent gets 5, child gets 10
    const updatedParent = parentPlanAfter;
    const updatedChild = childPlanAfter;

    expect(updatedParent.id).toBe(5); // Parent gets the lower ID
    expect(updatedChild.id).toBe(10); // Child gets the higher ID
    expect(updatedChild.parent).toBe(5); // Parent reference is updated
    expect(updatedParent.title).toBe('Parent Plan');
    expect(updatedChild.title).toBe('Child Plan');

    // Verify files were renamed correctly
    expect(files).toContain('5-parent.yml');
    expect(files).toContain('10-child.yml');
    expect(files).not.toContain('10-parent.yml'); // Old filename should be gone
    expect(files).not.toContain('5-child.yml'); // Old filename should be gone
  });

  test('end-to-end hierarchical renumbering with siblings and dependencies', async () => {
    // Create a disordered hierarchy with dependencies between siblings
    await createPlan(15, 'Parent Plan', '15-parent.yml');

    const child1Plan: PlanSchema = {
      id: 5,
      title: 'Child 1 - No dependencies',
      goal: 'Child 1 goal',
      details: 'Child 1 details',
      status: 'pending',
      priority: 'medium',
      parent: 15,
      dependencies: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '5-child1.yml'), yaml.stringify(child1Plan));

    const child2Plan: PlanSchema = {
      id: 8,
      title: 'Child 2 - Depends on Child 1',
      goal: 'Child 2 goal',
      details: 'Child 2 details',
      status: 'pending',
      priority: 'medium',
      parent: 15,
      dependencies: [5], // Depends on child 1
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '8-child2.yml'), yaml.stringify(child2Plan));

    // Run hierarchical renumbering
    await handleRenumber({}, createMockCommand());

    const files2 = await fs.promises.readdir(tasksDir);

    // After renumbering, should have parent (5), child1 (8), child2 (15)
    // Files should be renamed based on their new IDs
    const updatedParent = await readPlanFile(path.join(tasksDir, '5-parent.yml'));
    const updatedChild1 = await readPlanFile(path.join(tasksDir, '8-child1.yml'));
    const updatedChild2 = await readPlanFile(path.join(tasksDir, '15-child2.yml'));

    expect(updatedParent.id).toBe(5);
    expect(updatedChild1.id).toBe(8);
    expect(updatedChild2.id).toBe(15);

    // Verify parent-child relationships are maintained
    expect(updatedChild1.parent).toBe(5);
    expect(updatedChild2.parent).toBe(5);

    // Verify dependency is updated correctly
    expect(updatedChild2.dependencies).toEqual([8]); // Should now depend on child1's new ID

    // Verify files were renamed correctly
    const files = await fs.promises.readdir(tasksDir);
    expect(files).toContain('5-parent.yml');
    expect(files).toContain('8-child1.yml');
    expect(files).toContain('15-child2.yml');
  });

  test('end-to-end hierarchical renumbering preserves non-disordered families', async () => {
    // Create one disordered family and one properly ordered family

    // Disordered family: parent (10) -> child (5)
    await createPlan(10, 'Disordered Parent', '10-disordered-parent.yml');
    const disorderedChild: PlanSchema = {
      id: 5,
      title: 'Disordered Child',
      goal: 'Child goal',
      details: 'Child details',
      status: 'pending',
      priority: 'medium',
      parent: 10,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '5-disordered-child.yml'), yaml.stringify(disorderedChild));

    // Properly ordered family: parent (20) -> child (30)
    await createPlan(20, 'Ordered Parent', '20-ordered-parent.yml');
    const orderedChild: PlanSchema = {
      id: 30,
      title: 'Ordered Child',
      goal: 'Child goal',
      details: 'Child details',
      status: 'pending',
      priority: 'medium',
      parent: 20,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '30-ordered-child.yml'), yaml.stringify(orderedChild));

    // Run hierarchical renumbering
    await handleRenumber({}, createMockCommand());

    const files3 = await fs.promises.readdir(tasksDir);

    // Disordered family should be reordered
    const updatedDisorderedParent = await readPlanFile(
      path.join(tasksDir, '5-disordered-parent.yml')
    );
    const updatedDisorderedChild = await readPlanFile(
      path.join(tasksDir, '10-disordered-child.yml')
    );
    expect(updatedDisorderedParent.id).toBe(5);
    expect(updatedDisorderedChild.id).toBe(10);
    expect(updatedDisorderedChild.parent).toBe(5);

    // Properly ordered family should remain unchanged
    const orderedParentAfter = await readPlanFile(path.join(tasksDir, '20-ordered-parent.yml'));
    const orderedChildAfter = await readPlanFile(path.join(tasksDir, '30-ordered-child.yml'));
    expect(orderedParentAfter.id).toBe(20);
    expect(orderedChildAfter.id).toBe(30);
    expect(orderedChildAfter.parent).toBe(20);
  });

  test('end-to-end hierarchical renumbering dry run mode', async () => {
    // Create a disordered hierarchy
    await createPlan(10, 'Parent Plan', '10-parent.yml');

    const childPlan: PlanSchema = {
      id: 5,
      title: 'Child Plan',
      goal: 'Child goal',
      details: 'Child details',
      status: 'pending',
      priority: 'medium',
      parent: 10,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '5-child.yml'), yaml.stringify(childPlan));

    // Run in dry-run mode
    await handleRenumber({ dryRun: true }, createMockCommand());

    const files4 = await fs.promises.readdir(tasksDir);

    // Files should remain unchanged
    const parentAfter = await readPlanFile(path.join(tasksDir, '10-parent.yml'));
    const childAfter = await readPlanFile(path.join(tasksDir, '5-child.yml'));

    expect(parentAfter.id).toBe(10); // Should not be changed
    expect(childAfter.id).toBe(5); // Should not be changed
    expect(childAfter.parent).toBe(10); // Should not be changed

    // Original files should still exist
    expect(files4).toContain('10-parent.yml');
    expect(files4).toContain('5-child.yml');
    expect(files4).not.toContain('5-parent.yml'); // New files should not exist
    expect(files4).not.toContain('10-child.yml');
  });
});
