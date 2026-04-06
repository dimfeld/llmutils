import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { upsertPlan } from '$tim/db/plan.js';
import { linkPlanToPr, upsertPrStatus } from '$tim/db/pr_status.js';
import { getOrCreateProject } from '$tim/db/project.js';

import { searchPlans, searchPrs } from './command_bar_queries.js';

describe('command_bar_queries', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;
  let otherProjectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-command-bar-queries-test-'));
  });

  beforeEach(() => {
    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    projectId = getOrCreateProject(db, 'github.com__example__repo').id;
    otherProjectId = getOrCreateProject(db, 'github.com__other__repo').id;

    upsertPlan(db, projectId, {
      uuid: 'plan-active',
      planId: 42,
      title: 'Command palette keyboard shortcut',
      status: 'in_progress',
    });
    upsertPlan(db, projectId, {
      uuid: 'plan-done',
      planId: 43,
      title: 'Command palette shipped',
      status: 'done',
    });
    upsertPlan(db, projectId, {
      uuid: 'plan-cancelled',
      planId: 44,
      title: 'Command palette abandoned',
      status: 'cancelled',
    });
    upsertPlan(db, projectId, {
      uuid: 'plan-deferred',
      planId: 45,
      title: 'Command palette later',
      status: 'deferred',
    });
    upsertPlan(db, otherProjectId, {
      uuid: 'plan-other-project',
      planId: 46,
      title: 'Command palette for another project',
      status: 'pending',
    });
    upsertPlan(db, projectId, {
      uuid: 'plan-limit-1',
      planId: 47,
      title: 'Searchable item one',
      status: 'pending',
    });
    upsertPlan(db, projectId, {
      uuid: 'plan-limit-2',
      planId: 48,
      title: 'Searchable item two',
      status: 'pending',
    });
    upsertPlan(db, projectId, {
      uuid: 'plan-limit-3',
      planId: 49,
      title: 'Searchable item three',
      status: 'pending',
    });

    const repoMatchedPr = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/101',
      owner: 'example',
      repo: 'repo',
      prNumber: 101,
      title: 'Command palette server search',
      state: 'open',
      draft: false,
      author: 'dimfeld',
      lastFetchedAt: '2026-04-01T00:00:00.000Z',
    });
    const linkedOnlyPr = upsertPrStatus(db, {
      prUrl: 'https://github.com/no-project/misc/pull/102',
      owner: 'no-project',
      repo: 'misc',
      prNumber: 102,
      title: 'Command palette linked through plan',
      state: 'open',
      draft: false,
      author: 'dimfeld',
      lastFetchedAt: '2026-04-01T00:00:00.000Z',
    });
    const otherProjectPr = upsertPrStatus(db, {
      prUrl: 'https://github.com/other/repo/pull/103',
      owner: 'other',
      repo: 'repo',
      prNumber: 103,
      title: 'Command palette in other project',
      state: 'open',
      draft: false,
      author: 'dimfeld',
      lastFetchedAt: '2026-04-01T00:00:00.000Z',
    });
    const limitPr1 = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/104',
      owner: 'example',
      repo: 'repo',
      prNumber: 104,
      title: 'Searchable PR one',
      state: 'open',
      draft: false,
      author: 'dimfeld',
      lastFetchedAt: '2026-04-01T00:00:00.000Z',
    });
    const limitPr2 = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/105',
      owner: 'example',
      repo: 'repo',
      prNumber: 105,
      title: 'Searchable PR two',
      state: 'open',
      draft: false,
      author: 'dimfeld',
      lastFetchedAt: '2026-04-01T00:00:00.000Z',
    });
    const limitPr3 = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/106',
      owner: 'example',
      repo: 'repo',
      prNumber: 106,
      title: 'Searchable PR three',
      state: 'open',
      draft: false,
      author: 'dimfeld',
      lastFetchedAt: '2026-04-01T00:00:00.000Z',
    });

    linkPlanToPr(db, 'plan-active', linkedOnlyPr.status.id);
    linkPlanToPr(db, 'plan-other-project', otherProjectPr.status.id);

    void repoMatchedPr;
    void limitPr1;
    void limitPr2;
    void limitPr3;
  });

  afterEach(() => {
    db.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('searchPlans', () => {
    test('returns plans matching title substring', () => {
      expect(searchPlans(db, 'keyboard')).toEqual([
        expect.objectContaining({
          uuid: 'plan-active',
          planId: 42,
          title: 'Command palette keyboard shortcut',
          status: 'in_progress',
          projectId,
        }),
      ]);
    });

    test('returns plan by exact planId for numeric query', () => {
      expect(searchPlans(db, '42')).toEqual([
        expect.objectContaining({
          uuid: 'plan-active',
          planId: 42,
        }),
      ]);
    });

    test('omits terminal-status plans on title search but includes them on exact planId match', () => {
      const titleResults = searchPlans(db, 'Command palette');
      expect(titleResults.map((plan) => plan.planId)).toEqual(expect.arrayContaining([42, 46]));
      expect(titleResults.map((plan) => plan.planId)).not.toContain(43);
      expect(titleResults.map((plan) => plan.planId)).not.toContain(44);
      expect(titleResults.map((plan) => plan.planId)).not.toContain(45);

      expect(searchPlans(db, '43')).toEqual([
        expect.objectContaining({
          uuid: 'plan-done',
          planId: 43,
          status: 'done',
        }),
      ]);
      expect(searchPlans(db, '44')).toEqual([
        expect.objectContaining({
          uuid: 'plan-cancelled',
          planId: 44,
          status: 'cancelled',
        }),
      ]);
      expect(searchPlans(db, '45')).toEqual([
        expect.objectContaining({
          uuid: 'plan-deferred',
          planId: 45,
          status: 'deferred',
        }),
      ]);
    });

    test('respects projectId filter', () => {
      expect(searchPlans(db, 'Command palette', projectId).map((plan) => plan.projectId)).toEqual([
        projectId,
      ]);
      expect(searchPlans(db, 'Command palette', projectId).map((plan) => plan.planId)).toEqual([
        42,
      ]);
    });

    test('returns empty array for empty or whitespace query', () => {
      expect(searchPlans(db, '')).toEqual([]);
      expect(searchPlans(db, '   ')).toEqual([]);
    });

    test('respects the limit parameter', () => {
      const results = searchPlans(db, 'Searchable', undefined, 2);

      expect(results).toHaveLength(2);
      expect(results.map((plan) => plan.planId)).toEqual([49, 48]);
    });
  });

  describe('searchPrs', () => {
    test('returns PRs matching title substring', () => {
      const results = searchPrs(db, 'server');

      expect(results).toEqual([
        expect.objectContaining({
          pr_url: 'https://github.com/example/repo/pull/101',
          pr_number: 101,
          title: 'Command palette server search',
          owner: 'example',
          repo: 'repo',
          projectId,
        }),
      ]);
    });

    test('returns PR by exact pr_number', () => {
      expect(searchPrs(db, '101')).toEqual([
        expect.objectContaining({
          pr_url: 'https://github.com/example/repo/pull/101',
          pr_number: 101,
        }),
      ]);
    });

    test('derives projectId through linked plans and respects project filter', () => {
      const linkedResult = searchPrs(db, 'linked');
      expect(linkedResult).toEqual([
        expect.objectContaining({
          pr_url: 'https://github.com/no-project/misc/pull/102',
          projectId,
        }),
      ]);

      expect(searchPrs(db, 'Command palette', projectId).map((pr) => pr.pr_number)).toEqual([
        102,
        101,
      ]);
      expect(searchPrs(db, 'Command palette', otherProjectId).map((pr) => pr.pr_number)).toEqual([
        103,
      ]);
    });

    test('returns empty array for empty or whitespace query', () => {
      expect(searchPrs(db, '')).toEqual([]);
      expect(searchPrs(db, '   ')).toEqual([]);
    });

    test('respects the limit parameter', () => {
      const results = searchPrs(db, 'Searchable PR', undefined, 2);

      expect(results).toHaveLength(2);
      expect(results.map((pr) => pr.pr_number)).toEqual([106, 105]);
    });
  });
});
