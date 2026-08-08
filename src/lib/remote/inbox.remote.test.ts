import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { invokeCommand, invokeQuery } from '$lib/test-utils/invoke_command.js';
import { enrichInboxItems } from '$lib/server/inbox_enrichment.js';
import { openDatabase } from '$tim/db/database.js';
import {
  markInboxItemsRead as markInboxItemsReadRows,
  type InboxItemKind,
  type InboxItemRow,
  type UpsertInboxItemInput,
  upsertInboxItem,
} from '$tim/db/inbox_item.js';
import { linkPlanToPr, upsertPrStatus } from '$tim/db/pr_status.js';
import { nonSyncedUpsertPlan } from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';

let currentDb: Database;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

describe('inbox remote functions', () => {
  let projectId: number;
  let otherProjectId: number;
  let nextPrNumber: number;

  beforeEach(() => {
    currentDb = openDatabase(':memory:');
    projectId = getOrCreateProject(currentDb, 'github.com__example__repo').id;
    otherProjectId = getOrCreateProject(currentDb, 'github.com__other__repo').id;
    nextPrNumber = 1;
  });

  afterEach(() => {
    currentDb.close(false);
  });

  function seedInboxItem(overrides: Partial<UpsertInboxItemInput> = {}): InboxItemRow {
    const prNumber = overrides.prNumber === undefined ? nextPrNumber++ : overrides.prNumber;
    return upsertInboxItem(currentDb, {
      projectId,
      kind: 'pr_comment',
      prUrl: `https://github.com/example/repo/pull/${prNumber ?? nextPrNumber++}`,
      prNumber,
      repo: 'example/repo',
      prTitle: `Pull request ${prNumber ?? 'external'}`,
      actor: 'alice',
      summary: 'Inbox summary',
      eventAt: '2026-08-01T00:00:00.000Z',
      ...overrides,
    });
  }

  function addPlanLink(
    prUrl: string,
    planUuid: string,
    planId: number,
    linkedProjectId = projectId
  ): void {
    const prNumber = Number(prUrl.split('/').at(-1));
    const pr = upsertPrStatus(currentDb, {
      prUrl,
      owner: 'example',
      repo: 'repo',
      prNumber,
      title: `Linked PR ${prNumber}`,
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-08-01T00:00:00.000Z',
    });
    nonSyncedUpsertPlan(currentDb, linkedProjectId, {
      uuid: planUuid,
      planId,
      title: `Plan ${planId}`,
      filename: `${planId}.plan.md`,
    });
    linkPlanToPr(currentDb, planUuid, pr.status.id);
  }

  test('enriches hrefs, linked plans, and action descriptors for every inbox kind', async () => {
    const singlePlanUrl = 'https://github.com/example/repo/pull/101';
    const multiplePlanUrl = 'https://github.com/example/repo/pull/102';

    addPlanLink(singlePlanUrl, 'plan-single', 1);
    addPlanLink(multiplePlanUrl, 'plan-multiple-a', 2);
    addPlanLink(multiplePlanUrl, 'plan-multiple-b', 3);

    const rows = [
      seedInboxItem({ kind: 'review_requested', prNumber: 101, prUrl: singlePlanUrl }),
      seedInboxItem({ kind: 'pr_comment', prNumber: 102, prUrl: multiplePlanUrl }),
      seedInboxItem({ kind: 'reviewed_pr_comment', prNumber: 103 }),
      seedInboxItem({ kind: 'pr_merged', prNumber: 104 }),
      seedInboxItem({ kind: 'pr_approved', prNumber: 105 }),
      seedInboxItem({
        kind: 'ci_failure',
        prNumber: null,
        prUrl: 'https://github.com/example/repo/pull/106',
      }),
      seedInboxItem({ kind: 'merge_queue_removed', prNumber: 107 }),
    ];

    const items = enrichInboxItems(currentDb, rows);

    expect(items.find((item) => item.id === rows[0].id)).toMatchObject({
      viewHref: { href: `/projects/${projectId}/prs/101`, external: false },
      planHref: `/projects/${projectId}/plans/plan-single`,
      action: {
        type: 'review-guide',
        projectId,
        prNumber: 101,
        planUuid: 'plan-single',
      },
    });

    const multiplePlanItem = items.find((item) => item.id === rows[1].id);
    expect(multiplePlanItem).toMatchObject({
      viewHref: { href: `/projects/${projectId}/prs/102`, external: false },
      planHref: null,
      action: { type: 'pr-fix', projectId, prNumber: 102 },
    });
    expect(multiplePlanItem?.action).not.toHaveProperty('planUuid');

    const expectedActionTypes: Array<[InboxItemKind, string | null]> = [
      ['review_requested', 'review-guide'],
      ['pr_comment', 'pr-fix'],
      ['reviewed_pr_comment', 'pr-fix'],
      ['pr_merged', null],
      ['pr_approved', null],
      ['ci_failure', 'ci-fix'],
      ['merge_queue_removed', 'github'],
    ];
    for (const [kind, type] of expectedActionTypes) {
      const item = items.find((candidate) => candidate.kind === kind);
      expect(item?.action.type).toBe(type);
    }

    const externalItem = items.find((item) => item.kind === 'ci_failure');
    expect(externalItem?.viewHref).toEqual({
      href: 'https://github.com/example/repo/pull/106',
      external: true,
    });
  });

  test('scopes query results to one project or all projects and returns unread count', async () => {
    const { getInboxItems } = await import('./inbox.remote.js');
    const projectItem = seedInboxItem({
      prNumber: 201,
      eventAt: '2026-08-01T03:00:00.000Z',
    });
    const otherProjectItem = seedInboxItem({
      projectId: otherProjectId,
      prNumber: 202,
      prUrl: 'https://github.com/other/repo/pull/202',
      repo: 'other/repo',
      eventAt: '2026-08-01T02:00:00.000Z',
    });
    const readItem = seedInboxItem({
      prNumber: 203,
      eventAt: '2026-08-01T01:00:00.000Z',
    });
    markInboxItemsReadRows(currentDb, [readItem.id]);

    await expect(invokeQuery(getInboxItems, { projectId: 'all' })).resolves.toMatchObject({
      unreadCount: 2,
      items: [
        expect.objectContaining({ id: projectItem.id, project_id: projectId }),
        expect.objectContaining({ id: otherProjectItem.id, project_id: otherProjectId }),
      ],
    });

    await expect(
      invokeQuery(getInboxItems, { projectId: String(projectId) })
    ).resolves.toMatchObject({
      unreadCount: 1,
      items: [expect.objectContaining({ id: projectItem.id, project_id: projectId })],
    });
  });

  test('marks selected inbox items read', async () => {
    const { markInboxItemsRead } = await import('./inbox.remote.js');
    const item = seedInboxItem({ prNumber: 301 });

    await invokeCommand(markInboxItemsRead, { ids: [item.id] });

    const row = currentDb
      .prepare('SELECT read_at, dismissed_at FROM inbox_item WHERE id = ?')
      .get(item.id) as { read_at: string | null; dismissed_at: string | null };
    expect(row.read_at).not.toBeNull();
    expect(row.dismissed_at).toBeNull();
  });

  test('marks all items read for one project and then across all projects', async () => {
    const { markAllInboxItemsRead } = await import('./inbox.remote.js');
    const projectItem = seedInboxItem({ prNumber: 401 });
    const otherProjectItem = seedInboxItem({
      projectId: otherProjectId,
      prNumber: 402,
      prUrl: 'https://github.com/other/repo/pull/402',
      repo: 'other/repo',
    });

    await invokeCommand(markAllInboxItemsRead, { projectId: String(projectId) });

    const afterProjectRead = currentDb
      .prepare('SELECT id, read_at FROM inbox_item ORDER BY id')
      .all() as Array<{ id: number; read_at: string | null }>;
    expect(afterProjectRead).toEqual([
      { id: projectItem.id, read_at: expect.any(String) },
      { id: otherProjectItem.id, read_at: null },
    ]);

    await invokeCommand(markAllInboxItemsRead, { projectId: 'all' });

    const afterAllRead = currentDb
      .prepare('SELECT read_at FROM inbox_item ORDER BY id')
      .all() as Array<{ read_at: string | null }>;
    expect(afterAllRead).toEqual([
      { read_at: expect.any(String) },
      { read_at: expect.any(String) },
    ]);
  });

  test('dismisses an inbox item and marks it read', async () => {
    const { dismissInboxItem } = await import('./inbox.remote.js');
    const item = seedInboxItem({ prNumber: 501 });

    await invokeCommand(dismissInboxItem, { id: item.id });

    const row = currentDb
      .prepare('SELECT read_at, dismissed_at FROM inbox_item WHERE id = ?')
      .get(item.id) as { read_at: string | null; dismissed_at: string | null };
    expect(row.read_at).not.toBeNull();
    expect(row.dismissed_at).not.toBeNull();
  });
});
