import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAllTimCaches } from '../../testing.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { readPlanFile, resolvePlanFromDb, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { materializePlan } from '../plan_materialize.js';
import { handleSetCommand } from './set.js';

vi.mock('../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getGitRoot: vi.fn(),
  };
});

import { getGitRoot } from '../../common/git.js';

describe('tim set DB-first command', () => {
  let tempDir: string;
  let tasksDir: string;
  let globalOpts: any;

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-set-db-first-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, '.tim.yml'), 'paths:\n  tasks: tasks\n');
    vi.mocked(getGitRoot).mockResolvedValue(tempDir);
    globalOpts = { config: path.join(tempDir, '.tim.yml') };
  });

  afterEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    vi.clearAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('sets parent and updates the parent dependency in the DB', async () => {
    const parentPath = path.join(tasksDir, '1-parent.plan.md');
    const childPath = path.join(tasksDir, '2-child.plan.md');
    await writePlanFile(parentPath, {
      id: 1,
      title: 'Parent',
      goal: '',
      details: '',
      status: 'pending',
      tasks: [],
    } satisfies PlanSchema);
    await writePlanFile(childPath, {
      id: 2,
      title: 'Child',
      goal: '',
      details: '',
      status: 'pending',
      tasks: [],
    } satisfies PlanSchema);

    await handleSetCommand(childPath, { planFile: childPath, parent: 1 }, globalOpts);

    const child = await resolvePlanFromDb('2', tempDir);
    const parent = await resolvePlanFromDb('1', tempDir);
    expect(child.plan.parent).toBe(1);
    expect(parent.plan.dependencies).toContain(2);
  });

  test('marks an epic parent done when the last child is cancelled', async () => {
    const parentPath = path.join(tasksDir, '10-parent.plan.md');
    const child1Path = path.join(tasksDir, '11-child-a.plan.md');
    const child2Path = path.join(tasksDir, '12-child-b.plan.md');

    await writePlanFile(parentPath, {
      id: 10,
      title: 'Epic Parent',
      goal: '',
      details: '',
      status: 'in_progress',
      epic: true,
      tasks: [],
    } satisfies PlanSchema);
    await writePlanFile(child1Path, {
      id: 11,
      title: 'Child A',
      goal: '',
      details: '',
      status: 'done',
      parent: 10,
      tasks: [],
    } satisfies PlanSchema);
    await writePlanFile(child2Path, {
      id: 12,
      title: 'Child B',
      goal: '',
      details: '',
      status: 'in_progress',
      parent: 10,
      tasks: [],
    } satisfies PlanSchema);

    await handleSetCommand(child2Path, { planFile: child2Path, status: 'cancelled' }, globalOpts);

    const updatedParent = await resolvePlanFromDb('10', tempDir);
    const updatedChild = await resolvePlanFromDb('12', tempDir);
    expect(updatedChild.plan.status).toBe('cancelled');
    expect(updatedParent.plan.status).toBe('needs_review');
  });

  test('re-materializes a parent copy after reassigning a child', async () => {
    const parentPath = path.join(tasksDir, '20-parent.plan.md');
    const childPath = path.join(tasksDir, '21-child.plan.md');
    await writePlanFile(parentPath, {
      id: 20,
      title: 'Parent',
      goal: '',
      details: '',
      status: 'pending',
      tasks: [],
    } satisfies PlanSchema);
    await writePlanFile(childPath, {
      id: 21,
      title: 'Child',
      goal: '',
      details: '',
      status: 'pending',
      tasks: [],
    } satisfies PlanSchema);

    const materializedParentPath = await materializePlan(20, tempDir);
    const materializedParent = await readPlanFile(materializedParentPath);
    materializedParent.details = 'stale details';
    await writePlanFile(materializedParentPath, materializedParent, {
      skipDb: true,
      skipUpdatedAt: true,
    });

    await handleSetCommand(childPath, { planFile: childPath, parent: 20 }, globalOpts);

    const refreshedParent = await readPlanFile(materializedParentPath);
    expect(refreshedParent.dependencies).toContain(21);
  });
});
