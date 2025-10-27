import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PlanSchemaWithFilename } from '../planSchema.js';
import { readPlanFile, writePlanFile } from '../plans.js';
import { findPlanByUuid, resolvePlanWithUuid, verifyPlanIdCache } from './uuid_lookup.js';

describe('uuid_lookup utilities', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uuid-lookup-'));
  });

  afterEach(async () => {
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

  test('resolvePlanWithUuid returns persisted UUID for plan path', async () => {
    const planPath = path.join(tempDir, 'sample.plan.md');
    await writePlanFile(planPath, {
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
    });

    const result = await resolvePlanWithUuid(planPath);

    expect(result.uuid).toBe('123e4567-e89b-12d3-a456-426614179999');
    expect(result.plan.filename).toBe(planPath);
  });

  test('resolvePlanWithUuid generates and persists missing UUIDs', async () => {
    const planPath = path.join(tempDir, 'legacy.plan.md');
    await writePlanFile(planPath, {
      id: 101,
      goal: 'Legacy plan',
      details: '',
      tasks: [
        {
          title: 'Task',
          description: 'Legacy work',
          done: false,
          files: [],
          docs: [],
          steps: [],
        },
      ],
    });

    // Remove uuid from file to simulate legacy data.
    const initial = await fs.readFile(planPath, 'utf-8');
    const withoutUuid = initial.replace(/uuid:.*\n/, '');
    await fs.writeFile(planPath, withoutUuid, 'utf-8');

    const result = await resolvePlanWithUuid(planPath);
    expect(result.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    const reread = await readPlanFile(planPath);
    expect(reread.uuid).toBe(result.uuid);
  });
});
