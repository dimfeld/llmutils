import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';

import { openDatabase } from './database.js';
import {
  countUnreadInboxItems,
  dismissInboxItem,
  getInboxItemProjectIds,
  getInboxItemProjectIdsBefore,
  INBOX_ITEM_KINDS,
  listRecentInboxItems,
  markAllReadBefore,
  markInboxItemsRead,
  pruneOldInboxItems,
  type InboxItemRow,
  type UpsertInboxItemInput,
  upsertInboxItem,
} from './inbox_item.js';
import { getOrCreateProject } from './project.js';

const PR_URL_PREFIX = 'https://github.com/example/repo/pull/';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('tim db/inbox_item', () => {
  let db: Database;
  let projectId: number;
  let otherProjectId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    projectId = getOrCreateProject(db, 'repo-inbox-1').id;
    otherProjectId = getOrCreateProject(db, 'repo-inbox-2').id;
  });

  afterEach(() => {
    db.close(false);
  });

  function makeInput(overrides: Partial<UpsertInboxItemInput> = {}): UpsertInboxItemInput {
    const prNumber = overrides.prNumber ?? 1;
    return {
      projectId,
      kind: 'pr_comment',
      prUrl: `${PR_URL_PREFIX}${prNumber}`,
      prNumber,
      repo: 'example/repo',
      prTitle: `PR ${prNumber}`,
      actor: 'alice',
      summary: `Summary ${prNumber}`,
      eventAt: `2026-01-01T00:${String(prNumber).padStart(2, '0')}:00.000Z`,
      ...overrides,
    };
  }

  function getInboxRow(id: number): InboxItemRow {
    const row = db.prepare('SELECT * FROM inbox_item WHERE id = ?').get(id) as InboxItemRow | null;
    if (!row) {
      throw new Error(`Inbox item ${id} was not found`);
    }
    return row;
  }

  function daysAgo(days: number, offsetMs = 0): string {
    return new Date(Date.now() - days * DAY_MS + offsetMs).toISOString();
  }

  test('inserts a row with defaults and canonicalizes the PR URL', () => {
    const eventAt = '2026-02-01T10:00:00.000Z';

    const row = upsertInboxItem(db, {
      projectId,
      kind: 'review_requested',
      prUrl: `${PR_URL_PREFIX}7/files#discussion_r1`,
      eventAt,
    });

    expect(row).toMatchObject({
      id: expect.any(Number),
      project_id: projectId,
      kind: 'review_requested',
      pr_url: `${PR_URL_PREFIX}7`,
      pr_number: null,
      repo: null,
      pr_title: null,
      actor: null,
      event_count: 1,
      summary: null,
      dedupe_key: `review_requested:${PR_URL_PREFIX}7`,
      first_event_at: eventAt,
      last_event_at: eventAt,
      read_at: null,
      dismissed_at: null,
    });
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('defaults both event timestamps when the event time is omitted', () => {
    const row = upsertInboxItem(db, {
      projectId,
      kind: 'pr_comment',
      prUrl: `${PR_URL_PREFIX}8`,
    });

    expect(row.first_event_at).toBe(row.last_event_at);
    expect(row.first_event_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('uses an explicitly supplied dedupe key', () => {
    const row = upsertInboxItem(
      db,
      makeInput({
        dedupeKey: 'custom-inbox-key',
      })
    );

    expect(row.dedupe_key).toBe('custom-inbox-key');
  });

  test('aggregates the same kind and PR while keeping the first event', () => {
    const firstEventAt = '2026-02-01T10:00:00.000Z';
    const secondEventAt = '2026-02-02T10:00:00.000Z';
    const first = upsertInboxItem(
      db,
      makeInput({
        prNumber: 42,
        eventAt: firstEventAt,
        summary: 'First comment',
        actor: 'alice',
      })
    );

    const second = upsertInboxItem(
      db,
      makeInput({
        prNumber: 42,
        prUrl: `${PR_URL_PREFIX}42/files#discussion_r2`,
        eventAt: secondEventAt,
        summary: 'Second comment',
        actor: 'bob',
      })
    );

    expect(second).toMatchObject({
      id: first.id,
      event_count: 2,
      pr_url: `${PR_URL_PREFIX}42`,
      first_event_at: firstEventAt,
      last_event_at: secondEventAt,
      summary: 'Second comment',
      actor: 'bob',
    });

    const differentKind = upsertInboxItem(
      db,
      makeInput({
        kind: 'reviewed_pr_comment',
        prNumber: 42,
        eventAt: '2026-02-03T10:00:00.000Z',
      })
    );
    expect(differentKind.id).not.toBe(first.id);
    expect(listRecentInboxItems(db, { projectId: 'all', includeRead: true })).toHaveLength(2);
    expect(INBOX_ITEM_KINDS).toContain(differentKind.kind);
  });

  test('re-surfaces read and dismissed rows and orders them by their new event time', () => {
    const readRow = upsertInboxItem(
      db,
      makeInput({
        prNumber: 1,
        eventAt: '2026-03-01T10:00:00.000Z',
      })
    );
    const dismissedRow = upsertInboxItem(
      db,
      makeInput({
        kind: 'pr_approved',
        prNumber: 2,
        eventAt: '2026-03-01T11:00:00.000Z',
      })
    );
    const baselineRow = upsertInboxItem(
      db,
      makeInput({
        kind: 'pr_merged',
        prNumber: 3,
        eventAt: '2026-03-01T12:00:00.000Z',
      })
    );

    markInboxItemsRead(db, [readRow.id]);
    dismissInboxItem(db, dismissedRow.id);
    expect(listRecentInboxItems(db, { projectId, includeRead: true }).map((row) => row.id)).toEqual(
      [baselineRow.id, readRow.id]
    );

    const resurfacedRead = upsertInboxItem(
      db,
      makeInput({
        prNumber: 1,
        eventAt: '2026-03-01T14:00:00.000Z',
      })
    );
    const resurfacedDismissed = upsertInboxItem(
      db,
      makeInput({
        kind: 'pr_approved',
        prNumber: 2,
        eventAt: '2026-03-01T15:00:00.000Z',
      })
    );

    expect(resurfacedRead).toMatchObject({
      id: readRow.id,
      event_count: 2,
      read_at: null,
      dismissed_at: null,
    });
    expect(resurfacedDismissed).toMatchObject({
      id: dismissedRow.id,
      event_count: 2,
      read_at: null,
      dismissed_at: null,
    });
    expect(listRecentInboxItems(db, { projectId }).map((row) => row.id)).toEqual([
      dismissedRow.id,
      readRow.id,
      baselineRow.id,
    ]);
  });

  test('keeps sparse summary, actor, and title fields during aggregation', () => {
    const first = upsertInboxItem(
      db,
      makeInput({
        prNumber: 7,
        prTitle: 'Original title',
        actor: 'original-actor',
        summary: 'Original summary',
        eventAt: '2026-04-01T10:00:00.000Z',
      })
    );

    const second = upsertInboxItem(db, {
      projectId,
      kind: 'pr_comment',
      prUrl: `${PR_URL_PREFIX}7/files`,
      eventAt: '2026-04-02T10:00:00.000Z',
    });

    expect(second).toMatchObject({
      id: first.id,
      event_count: 2,
      pr_title: 'Original title',
      actor: 'original-actor',
      summary: 'Original summary',
      first_event_at: '2026-04-01T10:00:00.000Z',
      last_event_at: '2026-04-02T10:00:00.000Z',
    });
  });

  test('rejects an unknown kind without writing a row', () => {
    const invalidInput = {
      ...makeInput(),
      kind: 'not_a_kind' as UpsertInboxItemInput['kind'],
    };

    expect(() => upsertInboxItem(db, invalidInput)).toThrow('Unknown inbox item kind');
    const result = db.prepare('SELECT COUNT(*) AS count FROM inbox_item').get() as {
      count: number;
    };
    expect(result.count).toBe(0);
  });

  test('lists rows by event time with limit, read filtering, dismissal filtering, and project scopes', () => {
    const oldest = upsertInboxItem(
      db,
      makeInput({
        prNumber: 10,
        eventAt: '2026-05-01T10:00:00.000Z',
      })
    );
    const read = upsertInboxItem(
      db,
      makeInput({
        kind: 'review_requested',
        prNumber: 11,
        eventAt: '2026-05-01T11:00:00.000Z',
      })
    );
    const newest = upsertInboxItem(
      db,
      makeInput({
        kind: 'ci_failure',
        prNumber: 12,
        eventAt: '2026-05-01T12:00:00.000Z',
      })
    );
    const otherProject = upsertInboxItem(
      db,
      makeInput({
        kind: 'pr_merged',
        projectId: otherProjectId,
        prNumber: 13,
        eventAt: '2026-05-01T13:00:00.000Z',
      })
    );
    const dismissed = upsertInboxItem(
      db,
      makeInput({
        kind: 'merge_queue_removed',
        prNumber: 14,
        eventAt: '2026-05-01T14:00:00.000Z',
      })
    );

    markInboxItemsRead(db, [read.id]);
    dismissInboxItem(db, dismissed.id);

    expect(listRecentInboxItems(db, { projectId, includeRead: true }).map((row) => row.id)).toEqual(
      [newest.id, read.id, oldest.id]
    );
    expect(listRecentInboxItems(db, { projectId }).map((row) => row.id)).toEqual([
      newest.id,
      oldest.id,
    ]);
    expect(listRecentInboxItems(db, { projectId, limit: 1, includeRead: true })).toEqual([
      expect.objectContaining({ id: newest.id }),
    ]);
    expect(
      listRecentInboxItems(db, { projectId: 'all', includeRead: true }).map((row) => row.id)
    ).toEqual([otherProject.id, newest.id, read.id, oldest.id]);
    expect(listRecentInboxItems(db, { projectId: 'all' }).map((row) => row.id)).toEqual([
      otherProject.id,
      newest.id,
      oldest.id,
    ]);
  });

  test('counts only unread and undismissed rows for a project or all projects', () => {
    const projectUnread = upsertInboxItem(db, makeInput({ prNumber: 20 }));
    const projectRead = upsertInboxItem(
      db,
      makeInput({ kind: 'pr_approved', prNumber: 21, eventAt: '2026-05-02T00:00:00.000Z' })
    );
    const projectDismissed = upsertInboxItem(
      db,
      makeInput({ kind: 'pr_merged', prNumber: 22, eventAt: '2026-05-02T00:01:00.000Z' })
    );
    const otherUnread = upsertInboxItem(
      db,
      makeInput({
        projectId: otherProjectId,
        kind: 'ci_failure',
        prNumber: 23,
        eventAt: '2026-05-02T00:02:00.000Z',
      })
    );
    const otherRead = upsertInboxItem(
      db,
      makeInput({
        projectId: otherProjectId,
        kind: 'review_requested',
        prNumber: 24,
        eventAt: '2026-05-02T00:03:00.000Z',
      })
    );

    markInboxItemsRead(db, [projectRead.id, otherRead.id]);
    dismissInboxItem(db, projectDismissed.id);

    expect(countUnreadInboxItems(db, { projectId })).toBe(1);
    expect(countUnreadInboxItems(db, { projectId: otherProjectId })).toBe(1);
    expect(countUnreadInboxItems(db, { projectId: 'all' })).toBe(2);
    expect(getInboxRow(projectUnread.id).read_at).toBeNull();
    expect(getInboxRow(otherUnread.id).read_at).toBeNull();
  });

  test('returns distinct project IDs for selected inbox items', () => {
    const firstProjectItem = upsertInboxItem(db, makeInput({ prNumber: 25 }));
    const secondProjectItem = upsertInboxItem(db, makeInput({ prNumber: 26 }));
    const otherProjectItem = upsertInboxItem(
      db,
      makeInput({ projectId: otherProjectId, prNumber: 27 })
    );
    const unscopedItem = upsertInboxItem(db, makeInput({ projectId: null, prNumber: 28 }));

    expect(
      getInboxItemProjectIds(db, [
        otherProjectItem.id,
        firstProjectItem.id,
        secondProjectItem.id,
        otherProjectItem.id,
        unscopedItem.id,
        999999,
      ])
    ).toEqual([projectId, otherProjectId]);
    expect(getInboxItemProjectIds(db, [])).toEqual([]);
  });

  test('returns project IDs for unread items affected by mark-all', () => {
    const projectItem = upsertInboxItem(
      db,
      makeInput({ prNumber: 29, eventAt: '2026-05-02T00:00:00.000Z' })
    );
    const otherProjectItem = upsertInboxItem(
      db,
      makeInput({
        projectId: otherProjectId,
        prNumber: 30,
        eventAt: '2026-05-02T00:01:00.000Z',
      })
    );
    const futureItem = upsertInboxItem(
      db,
      makeInput({ prNumber: 31, eventAt: '2026-05-03T00:00:00.000Z' })
    );
    const readItem = upsertInboxItem(
      db,
      makeInput({ prNumber: 32, eventAt: '2026-05-02T00:02:00.000Z' })
    );
    const dismissedItem = upsertInboxItem(
      db,
      makeInput({ prNumber: 33, eventAt: '2026-05-02T00:03:00.000Z' })
    );

    markInboxItemsRead(db, [readItem.id]);
    dismissInboxItem(db, dismissedItem.id);

    expect(getInboxItemProjectIdsBefore(db, { cutoff: '2026-05-02T00:01:00.000Z' })).toEqual([
      projectId,
      otherProjectId,
    ]);
    expect(
      getInboxItemProjectIdsBefore(db, {
        cutoff: '2026-05-02T00:01:00.000Z',
        projectId,
      })
    ).toEqual([projectId]);
    expect(projectItem.id).not.toBe(futureItem.id);
    expect(otherProjectItem.id).not.toBe(readItem.id);
  });

  test('marks only selected items read and preserves their first read time', () => {
    const first = upsertInboxItem(db, makeInput({ prNumber: 30 }));
    const second = upsertInboxItem(
      db,
      makeInput({ kind: 'pr_approved', prNumber: 31, eventAt: '2026-05-03T00:00:00.000Z' })
    );
    const third = upsertInboxItem(
      db,
      makeInput({ kind: 'ci_failure', prNumber: 32, eventAt: '2026-05-03T00:01:00.000Z' })
    );

    markInboxItemsRead(db, [first.id, second.id]);
    const firstReadAt = getInboxRow(first.id).read_at;
    expect(firstReadAt).not.toBeNull();
    expect(getInboxRow(second.id).read_at).not.toBeNull();
    expect(getInboxRow(third.id).read_at).toBeNull();
    expect(countUnreadInboxItems(db, { projectId })).toBe(1);

    markInboxItemsRead(db, [first.id, second.id, 999999]);
    expect(getInboxRow(first.id).read_at).toBe(firstReadAt);
    expect(getInboxRow(second.id).read_at).not.toBeNull();
    expect(getInboxRow(third.id).read_at).toBeNull();
  });

  test('marks old unread rows read before a cutoff with optional project scope', () => {
    const projectOld = upsertInboxItem(
      db,
      makeInput({ prNumber: 40, eventAt: '2026-06-01T10:00:00.000Z' })
    );
    const projectAtCutoff = upsertInboxItem(
      db,
      makeInput({
        kind: 'pr_approved',
        prNumber: 41,
        eventAt: '2026-06-02T10:00:00.000Z',
      })
    );
    const projectNew = upsertInboxItem(
      db,
      makeInput({ kind: 'ci_failure', prNumber: 42, eventAt: '2026-06-03T10:00:00.000Z' })
    );
    const otherOld = upsertInboxItem(
      db,
      makeInput({
        projectId: otherProjectId,
        kind: 'pr_merged',
        prNumber: 43,
        eventAt: '2026-06-01T10:00:00.000Z',
      })
    );
    const otherNew = upsertInboxItem(
      db,
      makeInput({
        projectId: otherProjectId,
        kind: 'review_requested',
        prNumber: 44,
        eventAt: '2026-06-03T10:00:00.000Z',
      })
    );

    markAllReadBefore(db, {
      cutoff: '2026-06-02T10:00:00.000Z',
      projectId,
    });

    expect(getInboxRow(projectOld.id).read_at).not.toBeNull();
    expect(getInboxRow(projectAtCutoff.id).read_at).not.toBeNull();
    expect(getInboxRow(projectNew.id).read_at).toBeNull();
    expect(getInboxRow(otherOld.id).read_at).toBeNull();
    expect(getInboxRow(otherNew.id).read_at).toBeNull();

    markAllReadBefore(db, { cutoff: '2026-06-02T10:00:00.000Z' });
    expect(getInboxRow(otherOld.id).read_at).not.toBeNull();
    expect(getInboxRow(otherNew.id).read_at).toBeNull();
    expect(getInboxRow(projectNew.id).read_at).toBeNull();
  });

  test('dismisses a row, marks it read, and excludes it from lists and counts', () => {
    const row = upsertInboxItem(db, makeInput({ prNumber: 50 }));

    dismissInboxItem(db, row.id);

    const dismissed = getInboxRow(row.id);
    expect(dismissed.dismissed_at).not.toBeNull();
    expect(dismissed.read_at).not.toBeNull();
    expect(listRecentInboxItems(db, { projectId, includeRead: true })).toHaveLength(0);
    expect(countUnreadInboxItems(db, { projectId })).toBe(0);
  });

  test('prunes rows older than the default and custom age boundaries and returns deleted counts', () => {
    const olderThanDefault = upsertInboxItem(
      db,
      makeInput({ prNumber: 60, eventAt: daysAgo(30, -1000) })
    );
    const newerThanDefault = upsertInboxItem(
      db,
      makeInput({ kind: 'pr_approved', prNumber: 61, eventAt: daysAgo(30, 1000) })
    );
    const olderThanCustom = upsertInboxItem(
      db,
      makeInput({ kind: 'ci_failure', prNumber: 62, eventAt: daysAgo(10, -1000) })
    );
    const newerThanCustom = upsertInboxItem(
      db,
      makeInput({ kind: 'pr_merged', prNumber: 63, eventAt: daysAgo(10, 1000) })
    );

    expect(pruneOldInboxItems(db)).toBe(1);
    expect(() => getInboxRow(olderThanDefault.id)).toThrow('was not found');
    expect(
      listRecentInboxItems(db, { projectId: 'all', includeRead: true }).map((row) => row.id)
    ).toEqual([newerThanCustom.id, olderThanCustom.id, newerThanDefault.id]);

    expect(pruneOldInboxItems(db, 10)).toBe(2);
    expect(() => getInboxRow(olderThanCustom.id)).toThrow('was not found');
    expect(
      listRecentInboxItems(db, { projectId: 'all', includeRead: true }).map((row) => row.id)
    ).toEqual([newerThanCustom.id]);
  });

  test('cascades inbox rows when their project is deleted', () => {
    const projectRow = upsertInboxItem(db, makeInput({ prNumber: 70 }));
    const otherProjectRow = upsertInboxItem(
      db,
      makeInput({ projectId: otherProjectId, kind: 'pr_merged', prNumber: 71 })
    );

    db.prepare('DELETE FROM project WHERE id = ?').run(projectId);

    expect(() => getInboxRow(projectRow.id)).toThrow('was not found');
    expect(listRecentInboxItems(db, { projectId: 'all', includeRead: true })).toEqual([
      expect.objectContaining({ id: otherProjectRow.id, project_id: otherProjectId }),
    ]);
  });
});
