import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { clearAllTimCaches } from '../../testing.js';
import { claimPlan } from '../assignments/claim_plan.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { getAssignment } from '../db/assignment.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getPlanByUuid } from '../db/plan.js';
import { getOrCreateProject } from '../db/project.js';
import { getMaterializedPlanPath } from '../plan_materialize.js';
import { writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { handleRemoveCommand } from './remove.js';

describe('tim remove command DB cleanup flow', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;
  let repositoryId: string;

  const makeCommand = () => ({
    parent: {
      opts: () => ({ config: configPath }),
    },
  });

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-remove-db-order-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    configPath = path.join(tempDir, '.rmfilter', 'tim.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: {
          tasks: tasksDir,
        },
      })
    );

    repositoryId = (await getRepositoryIdentity({ cwd: tempDir })).repositoryId;
  });

  afterEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writePlan(id: number, overrides: Partial<PlanSchema> = {}): Promise<string> {
    const filePath = getMaterializedPlanPath(tempDir, id);
    const basePlan: PlanSchema = {
      id,
      uuid: crypto.randomUUID(),
      title: `Plan ${id}`,
      goal: `Goal ${id}`,
      details: `Details ${id}`,
      status: 'pending',
      tasks: [],
    };

    await writePlanFile(filePath, { ...basePlan, ...overrides }, { cwdForIdentity: tempDir });
    return filePath;
  }

  function getProjectId(): number {
    return getOrCreateProject(getDatabase(), repositoryId).id;
  }

  test('removes the plan file and deletes the DB row', async () => {
    const planUuid = '11111111-1111-4111-8111-111111111111';
    const planPath = await writePlan(1, { uuid: planUuid });

    await handleRemoveCommand([1], {}, makeCommand());

    await expect(fs.access(planPath)).rejects.toThrow();
    expect(getPlanByUuid(getDatabase(), planUuid)).toBeNull();
  });

  test('removes any assignment row alongside the plan row', async () => {
    const planUuid = '22222222-2222-4222-8222-222222222222';
    await writePlan(1, { uuid: planUuid });

    await claimPlan(1, {
      uuid: planUuid,
      repositoryId,
      repositoryRemoteUrl: null,
      workspacePath: tempDir,
      user: 'alice',
    });

    expect(getAssignment(getDatabase(), getProjectId(), planUuid)).not.toBeNull();

    await handleRemoveCommand([1], {}, makeCommand());

    expect(getPlanByUuid(getDatabase(), planUuid)).toBeNull();
    expect(getAssignment(getDatabase(), getProjectId(), planUuid)).toBeNull();
  });
});
