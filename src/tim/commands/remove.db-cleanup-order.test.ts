import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { ModuleMocker, clearAllTimCaches, stringifyPlanWithFrontmatter } from '../../testing.js';
import type { PlanSchema } from '../planSchema.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('tim remove command DB cleanup flow', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;

  const removePlanFromDbMock = mock(async () => {});
  const removePlanAssignmentMock = mock(async () => {});
  const existsAtDbCleanupCall: boolean[] = [];

  const makeCommand = () => ({
    parent: {
      opts: () => ({ config: configPath }),
    },
  });

  beforeEach(async () => {
    clearAllTimCaches();

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

    removePlanFromDbMock.mockReset();
    removePlanAssignmentMock.mockReset();
    existsAtDbCleanupCall.length = 0;
  });

  afterEach(async () => {
    clearAllTimCaches();
    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writePlan(id: number, overrides: Partial<PlanSchema> = {}): Promise<string> {
    const filePath = path.join(tasksDir, `${id}.plan.md`);
    const basePlan: PlanSchema = {
      id,
      uuid: crypto.randomUUID(),
      title: `Plan ${id}`,
      goal: `Goal ${id}`,
      details: `Details ${id}`,
      status: 'pending',
      tasks: [],
    };

    await fs.writeFile(filePath, stringifyPlanWithFrontmatter({ ...basePlan, ...overrides }));
    return filePath;
  }

  test('deletes plan file before DB cleanup', async () => {
    const planPath = await writePlan(1, { uuid: '11111111-1111-4111-8111-111111111111' });

    await moduleMocker.mock('../db/plan_sync.js', () => ({
      removePlanFromDb: mock(async () => {
        const exists = await fs
          .access(planPath)
          .then(() => true)
          .catch(() => false);
        existsAtDbCleanupCall.push(exists);
      }),
    }));

    const { handleRemoveCommand } = await import('./remove.js');
    await handleRemoveCommand(['1'], {}, makeCommand());

    expect(existsAtDbCleanupCall).toEqual([false]);
  });

  test('does not call removePlanAssignment directly', async () => {
    await writePlan(1, { uuid: '22222222-2222-4222-8222-222222222222' });

    await moduleMocker.mock('../db/plan_sync.js', () => ({
      removePlanFromDb: removePlanFromDbMock,
    }));
    await moduleMocker.mock('../assignments/remove_plan_assignment.js', () => ({
      removePlanAssignment: removePlanAssignmentMock,
    }));

    const { handleRemoveCommand } = await import('./remove.js');
    await handleRemoveCommand(['1'], {}, makeCommand());

    expect(removePlanFromDbMock).toHaveBeenCalledTimes(1);
    expect(removePlanAssignmentMock).not.toHaveBeenCalled();
  });
});
