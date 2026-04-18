import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PlanSchemaWithFilename } from '../planSchema.js';
import { readPlanFile, writePlanFile, writePlanToDb } from '../plans.js';
import { findPlanByUuid, resolvePlanWithUuid, verifyPlanIdCache } from './uuid_lookup.js';

describe('uuid_lookup utilities', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uuid-lookup-'));
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/acme/uuid-lookup-tests.git`
      .cwd(tempDir)
      .quiet();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('findPlanByUuid returns matching plan from cache', () => {
    const first: PlanSchemaWithFilename = {
      id: 1,
      uuid: '123e4567-e89b-12d3-a456-426614174000',
      goal: 'Goal A',
      details: '',
      tasks: [],
      filename: path.join(tempDir, 'plan-a.plan.md'),
    };
    const second: PlanSchemaWithFilename = {
      id: 2,
      uuid: '123e4567-e89b-12d3-a456-426614174111',
      goal: 'Goal B',
      details: '',
      tasks: [],
      filename: path.join(tempDir, 'plan-b.plan.md'),
    };

    const allPlans = new Map<number, PlanSchemaWithFilename>([
      [first.id!, first],
      [second.id!, second],
    ]);

    expect(findPlanByUuid('123e4567-e89b-12d3-a456-426614174111', allPlans)).toBe(second);
    expect(findPlanByUuid('missing', allPlans)).toBeUndefined();
  });

  test('verifyPlanIdCache uses fast path when planId matches', () => {
    const plan: PlanSchemaWithFilename = {
      id: 7,
      uuid: '123e4567-e89b-12d3-a456-426614174999',
      goal: 'Cached plan',
      details: '',
      tasks: [],
      filename: path.join(tempDir, 'plan.plan.md'),
    };
    const allPlans = new Map<number, PlanSchemaWithFilename>([[plan.id!, plan]]);

    const result = verifyPlanIdCache(plan.id, plan.uuid!, allPlans);
    expect(result).toEqual({
      plan,
      planId: plan.id,
      cacheUpdated: false,
    });
  });

  test('verifyPlanIdCache falls back to UUID scan when planId is stale', () => {
    const plan: PlanSchemaWithFilename = {
      id: 10,
      uuid: '123e4567-e89b-12d3-a456-426614175555',
      goal: 'Renumbered plan',
      details: '',
      tasks: [],
      filename: path.join(tempDir, 'renumbered.plan.md'),
    };
    const allPlans = new Map<number, PlanSchemaWithFilename>([[plan.id!, plan]]);

    const result = verifyPlanIdCache(4, plan.uuid!, allPlans);
    expect(result).toEqual({
      plan,
      planId: plan.id,
      cacheUpdated: true,
    });
  });

  test('verifyPlanIdCache returns null when plan cannot be found', () => {
    const allPlans = new Map<number, PlanSchemaWithFilename>();
    expect(verifyPlanIdCache(1, 'missing', allPlans)).toBeNull();
  });

  test('resolvePlanWithUuid returns persisted UUID for plan ID', async () => {
    await writePlanToDb(
      {
        id: 42,
        uuid: '123e4567-e89b-12d3-a456-426614179999',
        goal: 'Sample goal',
        details: '',
        tasks: [
          {
            title: 'Task',
            description: 'Do something',
            done: false,
            files: [],
            docs: [],
            steps: [],
          },
        ],
      },
      { cwdForIdentity: tempDir }
    );

    const result = await resolvePlanWithUuid(42);

    expect(result.uuid).toBe('123e4567-e89b-12d3-a456-426614179999');
    expect(result.plan.id).toBe(42);
  });

  test('resolvePlanWithUuid succeeds for plans written without an explicit UUID (auto-generated)', async () => {
    const planPath = path.join(tempDir, 'legacy.plan.md');
    await writePlanFile(
      planPath,
      {
        id: 101,
        goal: 'Legacy plan',
        details: '',
        tasks: [
          {
            title: 'Task',
            description: 'Legacy work',
            done: false,
          },
        ],
      },
      { cwdForIdentity: tempDir }
    );

    // writePlanFile now auto-generates UUIDs, so resolvePlanWithUuid should succeed
    const result = await resolvePlanWithUuid(101);
    expect(result.plan.id).toBe(101);
    expect(result.uuid).toBeDefined();
    expect(typeof result.uuid).toBe('string');

    const reread = await readPlanFile(planPath);
    expect(reread.id).toBe(101);
  });
});
