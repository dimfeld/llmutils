import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectDependenciesInOrder,
  getBlockedPlans,
  getChildPlans,
  getDiscoveredPlans,
  isPlanReady,
  parsePlanIdFromCliArg,
  parsePlanIdentifier,
  readPlanFile,
  resolvePlanFromDb,
  setPlanStatus,
  setPlanStatusById,
  writePlanFile,
  writePlanToDb,
} from './plans.js';
import type { PlanSchema } from './planSchema.js';
import { materializePlan } from './plan_materialize.js';

async function initializeGitRepository(repoDir: string): Promise<void> {
  await Bun.$`git init`.cwd(repoDir).quiet();
  await Bun.$`git remote add origin https://example.com/acme/plans-tests.git`.cwd(repoDir).quiet();
}

describe('plans', () => {
  let tempDir: string;
  let repoDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), 'tim-plans-test-'));
    repoDir = join(tempDir, 'repo');
    await mkdir(repoDir, { recursive: true });
    await initializeGitRepository(repoDir);
    process.chdir(repoDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  test('parsePlanIdentifier handles numeric IDs and UUIDs', () => {
    expect(parsePlanIdentifier(12)).toEqual({ planId: 12 });
    expect(parsePlanIdentifier('34')).toEqual({ planId: 34 });
    expect(parsePlanIdentifier('56-feature.plan.md')).toEqual({});
    expect(parsePlanIdentifier('123e4567-e89b-42d3-a456-426614174000')).toEqual({
      uuid: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(parsePlanIdentifier('not-a-plan')).toEqual({});
  });

  test('parsePlanIdFromCliArg accepts positive numeric IDs', () => {
    expect(parsePlanIdFromCliArg('12')).toBe(12);
    expect(parsePlanIdFromCliArg(' 34 ')).toBe(34);
    expect(parsePlanIdFromCliArg('1')).toBe(1);
    expect(parsePlanIdFromCliArg('99999')).toBe(99999);
  });

  test('parsePlanIdFromCliArg rejects non-numeric input', () => {
    expect(() => parsePlanIdFromCliArg('abc')).toThrow(
      'Expected a numeric plan ID, got: "abc"'
    );
    expect(() => parsePlanIdFromCliArg('56-feature.plan.md')).toThrow(
      'Expected a numeric plan ID, got: "56-feature.plan.md"'
    );
  });

  test('parsePlanIdFromCliArg rejects zero', () => {
    expect(() => parsePlanIdFromCliArg('0')).toThrow(
      'Expected a numeric plan ID, got: "0"'
    );
  });

  test('parsePlanIdFromCliArg rejects negative numbers', () => {
    expect(() => parsePlanIdFromCliArg('-1')).toThrow(
      'Expected a numeric plan ID, got: "-1"'
    );
    expect(() => parsePlanIdFromCliArg('-100')).toThrow(
      'Expected a numeric plan ID, got: "-100"'
    );
  });

  test('parsePlanIdFromCliArg rejects floats', () => {
    expect(() => parsePlanIdFromCliArg('1.5')).toThrow(
      'Expected a numeric plan ID, got: "1.5"'
    );
    expect(() => parsePlanIdFromCliArg('3.14')).toThrow(
      'Expected a numeric plan ID, got: "3.14"'
    );
  });

  test('parsePlanIdFromCliArg rejects UUIDs', () => {
    expect(() => parsePlanIdFromCliArg('123e4567-e89b-42d3-a456-426614174000')).toThrow(
      'Expected a numeric plan ID, got: "123e4567-e89b-42d3-a456-426614174000"'
    );
  });

  test('parsePlanIdFromCliArg rejects empty strings', () => {
    expect(() => parsePlanIdFromCliArg('')).toThrow(
      'Expected a numeric plan ID, got: ""'
    );
    expect(() => parsePlanIdFromCliArg('   ')).toThrow(
      'Expected a numeric plan ID, got: "   "'
    );
  });

  test('parsePlanIdFromCliArg rejects absolute file paths', () => {
    expect(() => parsePlanIdFromCliArg('/path/to/42.plan.md')).toThrow(
      'Expected a numeric plan ID, got: "/path/to/42.plan.md"'
    );
  });

  test('relationship helpers find blocked, child, and discovered plans', () => {
    const plans = new Map<number, PlanSchema>([
      [1, { id: 1, title: 'Parent', goal: 'g', tasks: [] }],
      [
        2,
        {
          id: 2,
          title: 'Blocked',
          goal: 'g',
          dependencies: [1],
          tasks: [],
        },
      ],
      [3, { id: 3, title: 'Child', goal: 'g', parent: 1, tasks: [] }],
      [
        4,
        {
          id: 4,
          title: 'Discovered',
          goal: 'g',
          discoveredFrom: 1,
          tasks: [],
        },
      ],
    ]);

    expect(getBlockedPlans(1, plans).map((plan) => plan.id)).toEqual([2]);
    expect(getChildPlans(1, plans).map((plan) => plan.id)).toEqual([3]);
    expect(getDiscoveredPlans(1, plans).map((plan) => plan.id)).toEqual([4]);
  });

  test('isPlanReady treats needs_review dependencies as ready', () => {
    const plans = new Map<number, PlanSchema>([
      [
        1,
        {
          id: 1,
          title: 'Ready once review starts',
          goal: 'g',
          status: 'pending',
          dependencies: [2, 3],
          tasks: [],
        },
      ],
      [2, { id: 2, title: 'Reviewed dependency', goal: 'g', status: 'needs_review', tasks: [] }],
      [3, { id: 3, title: 'Done dependency', goal: 'g', status: 'done', tasks: [] }],
    ]);

    expect(isPlanReady(plans.get(1)!, plans)).toBe(true);
  });

  test('collectDependenciesInOrder skips needs_review dependencies like done dependencies', async () => {
    const plans = new Map<number, PlanSchema>([
      [
        1,
        {
          id: 1,
          title: 'Parent',
          goal: 'g',
          status: 'pending',
          dependencies: [2, 3],
          tasks: [],
        },
      ],
      [
        2,
        {
          id: 2,
          title: 'Needs review dependency',
          goal: 'g',
          status: 'needs_review',
          tasks: [],
        },
      ],
      [
        3,
        {
          id: 3,
          title: 'Pending dependency',
          goal: 'g',
          status: 'pending',
          tasks: [],
        },
      ],
    ]);

    const ordered = await collectDependenciesInOrder(1, plans);

    expect(ordered.map((plan) => plan.id)).toEqual([3, 1]);
  });

  test('resolvePlanFromDb returns the materialized path when present', async () => {
    await writePlanToDb(
      {
        id: 20,
        uuid: '20202020-2020-4020-8020-202020202020',
        title: 'DB plan',
        goal: 'Resolve from DB',
        details: 'DB details',
        tasks: [],
      },
      { cwdForIdentity: repoDir }
    );

    const materializedPath = await materializePlan(20, repoDir);
    const resolved = await resolvePlanFromDb('20', repoDir);

    expect(resolved.plan.id).toBe(20);
    expect(resolved.plan.title).toBe('DB plan');
    expect(resolved.planPath).toBe(materializedPath);
  });

  test('resolvePlanFromDb rejects file-like identifiers', async () => {
    await expect(resolvePlanFromDb('56-feature.plan.md', repoDir)).rejects.toThrow(
      'Could not parse plan identifier: expected a numeric plan ID or UUID, got: "56-feature.plan.md"'
    );
  });

  test('resolvePlanFromDb rejects relative path to a real file', async () => {
    const planPath = join(repoDir, '99-real.plan.md');
    await Bun.write(planPath, '---\nid: 99\ntitle: Real file plan\n---\n');
    await expect(resolvePlanFromDb('99-real.plan.md', repoDir)).rejects.toThrow(
      'Could not parse plan identifier: expected a numeric plan ID or UUID, got: "99-real.plan.md"'
    );
  });

  test('resolvePlanFromDb rejects absolute path to a real file', async () => {
    const planPath = join(repoDir, '88-abs.plan.md');
    await Bun.write(planPath, '---\nid: 88\ntitle: Absolute path plan\n---\n');
    await expect(resolvePlanFromDb(planPath, repoDir)).rejects.toThrow(
      'Could not parse plan identifier: expected a numeric plan ID or UUID'
    );
  });

  test('setPlanStatus updates a plan file on disk', async () => {
    const planPath = join(repoDir, 'status.plan.md');
    await writePlanFile(planPath, {
      id: 30,
      uuid: '30303030-3030-4030-8030-303030303030',
      title: 'Status plan',
      goal: 'Update status',
      status: 'pending',
      tasks: [],
    });

    await setPlanStatus(planPath, 'done');

    const updated = await readPlanFile(planPath);
    expect(updated.status).toBe('done');
  });

  test('setPlanStatusById updates the DB-backed materialized plan', async () => {
    await writePlanToDb(
      {
        id: 40,
        uuid: '40404040-4040-4040-8040-404040404040',
        title: 'DB status plan',
        goal: 'Update DB status',
        status: 'pending',
        tasks: [],
      },
      { cwdForIdentity: repoDir }
    );
    const materializedPath = await materializePlan(40, repoDir);

    await setPlanStatusById(40, 'done', repoDir);

    const updated = await readPlanFile(materializedPath);
    expect(updated.status).toBe('done');
    const resolved = await resolvePlanFromDb('40', repoDir);
    expect(resolved.plan.status).toBe('done');
  });
});
