import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import {
  deleteUserMapping,
  getUserMapping,
  listUserMappings,
  upsertUserMapping,
} from './slack_user_map.js';

describe('tim db/slack_user_map', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-slack-user-map-db-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('migration schema', () => {
    test('slack_user_map table exists with expected columns', () => {
      const columns = db.prepare("PRAGMA table_info('slack_user_map')").all() as Array<{
        name: string;
        notnull: number;
        pk: number;
      }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain('workspace');
      expect(names).toContain('github_login');
      expect(names).toContain('slack_user_id');
      expect(names).toContain('slack_display');
      expect(names).toContain('created_at');
      expect(names).toContain('updated_at');
    });

    test('slack_user_map primary key is (workspace, github_login)', () => {
      const columns = db.prepare("PRAGMA table_info('slack_user_map')").all() as Array<{
        name: string;
        pk: number;
      }>;
      const pkColumns = columns.filter((c) => c.pk > 0).map((c) => c.name);
      expect(pkColumns).toContain('workspace');
      expect(pkColumns).toContain('github_login');
      expect(pkColumns).toHaveLength(2);
    });

    test('pr_review_request has notification tracking columns', () => {
      const columns = db.prepare("PRAGMA table_info('pr_review_request')").all() as Array<{
        name: string;
      }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain('notified_at');
      expect(names).toContain('request_version');
    });

    test('notification tracking columns have expected constraints and no CHECK constraints', () => {
      const columnInfo = db.prepare("PRAGMA table_info('pr_review_request')").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const notifiedAtCol = columnInfo.find((c) => c.name === 'notified_at');
      const requestVersionCol = columnInfo.find((c) => c.name === 'request_version');
      expect(notifiedAtCol).toBeDefined();
      // Must be nullable (not required) so that existing rows are unaffected
      expect(notifiedAtCol!.notnull).toBe(0);
      expect(requestVersionCol).toBeDefined();
      expect(requestVersionCol!.notnull).toBe(1);
      expect(requestVersionCol!.dflt_value).toBe('0');

      // Verify there is no table-level CHECK constraint referencing notification columns
      const tableSchema = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pr_review_request'"
        )
        .get() as { sql: string } | undefined;
      expect(tableSchema?.sql).not.toMatch(/CHECK.*notified_at/i);
      expect(tableSchema?.sql).not.toMatch(/CHECK.*request_version/i);
    });
  });

  describe('upsertUserMapping', () => {
    test('inserts a new row with all fields', () => {
      upsertUserMapping(db, {
        workspace: 'work',
        githubLogin: 'alice',
        slackUserId: 'U12345',
        slackDisplay: 'Alice',
      });

      const row = getUserMapping(db, 'work', 'alice');
      expect(row).toBeDefined();
      expect(row!.workspace).toBe('work');
      expect(row!.github_login).toBe('alice');
      expect(row!.slack_user_id).toBe('U12345');
      expect(row!.slack_display).toBe('Alice');
      expect(row!.created_at).toBeTruthy();
      expect(row!.updated_at).toBeTruthy();
    });

    test('inserts a new row without slackDisplay (null)', () => {
      upsertUserMapping(db, {
        workspace: 'work',
        githubLogin: 'bob',
        slackUserId: 'U99999',
      });

      const row = getUserMapping(db, 'work', 'bob');
      expect(row).toBeDefined();
      expect(row!.slack_display).toBeNull();
    });

    test('updates slack_user_id and slack_display on conflict', () => {
      upsertUserMapping(db, {
        workspace: 'work',
        githubLogin: 'alice',
        slackUserId: 'U12345',
        slackDisplay: 'Alice',
      });
      const first = getUserMapping(db, 'work', 'alice')!;

      upsertUserMapping(db, {
        workspace: 'work',
        githubLogin: 'alice',
        slackUserId: 'U99999',
        slackDisplay: 'Alice Updated',
      });
      const second = getUserMapping(db, 'work', 'alice')!;

      expect(second.slack_user_id).toBe('U99999');
      expect(second.slack_display).toBe('Alice Updated');
      // created_at must remain stable
      expect(second.created_at).toBe(first.created_at);
    });

    test('preserves slack_display on conflict when no new display is provided', () => {
      upsertUserMapping(db, {
        workspace: 'work',
        githubLogin: 'alice',
        slackUserId: 'U12345',
        slackDisplay: 'Alice',
      });

      upsertUserMapping(db, {
        workspace: 'work',
        githubLogin: 'alice',
        slackUserId: 'U99999',
      });
      const row = getUserMapping(db, 'work', 'alice')!;

      expect(row.slack_user_id).toBe('U99999');
      expect(row.slack_display).toBe('Alice');
    });

    test('updated_at is >= created_at after upsert', () => {
      upsertUserMapping(db, {
        workspace: 'work',
        githubLogin: 'carol',
        slackUserId: 'U11111',
      });
      const first = getUserMapping(db, 'work', 'carol')!;

      upsertUserMapping(db, {
        workspace: 'work',
        githubLogin: 'carol',
        slackUserId: 'U22222',
      });
      const second = getUserMapping(db, 'work', 'carol')!;

      expect(second.updated_at >= second.created_at).toBe(true);
      // created_at is unchanged
      expect(second.created_at).toBe(first.created_at);
    });

    test('same github_login in different workspaces are independent rows', () => {
      upsertUserMapping(db, { workspace: 'work', githubLogin: 'alice', slackUserId: 'UWORK' });
      upsertUserMapping(db, {
        workspace: 'personal',
        githubLogin: 'alice',
        slackUserId: 'UPERSONAL',
      });

      const workRow = getUserMapping(db, 'work', 'alice');
      const personalRow = getUserMapping(db, 'personal', 'alice');

      expect(workRow!.slack_user_id).toBe('UWORK');
      expect(personalRow!.slack_user_id).toBe('UPERSONAL');
    });
  });

  describe('getUserMapping', () => {
    test('returns undefined when no mapping exists', () => {
      expect(getUserMapping(db, 'work', 'nonexistent')).toBeUndefined();
    });

    test('returns the row when a mapping exists', () => {
      upsertUserMapping(db, { workspace: 'work', githubLogin: 'dave', slackUserId: 'UDAVE' });
      const row = getUserMapping(db, 'work', 'dave');
      expect(row).toBeDefined();
      expect(row!.github_login).toBe('dave');
    });

    test('does not return a row from a different workspace', () => {
      upsertUserMapping(db, { workspace: 'personal', githubLogin: 'dave', slackUserId: 'UDAVE' });
      expect(getUserMapping(db, 'work', 'dave')).toBeUndefined();
    });
  });

  describe('deleteUserMapping', () => {
    test('removes an existing mapping and returns true', () => {
      upsertUserMapping(db, { workspace: 'work', githubLogin: 'eve', slackUserId: 'UEVE' });
      expect(deleteUserMapping(db, 'work', 'eve')).toBe(true);
      expect(getUserMapping(db, 'work', 'eve')).toBeUndefined();
    });

    test('returns false when no matching row exists', () => {
      expect(deleteUserMapping(db, 'work', 'nobody')).toBe(false);
    });

    test('does not delete a row from a different workspace', () => {
      upsertUserMapping(db, {
        workspace: 'personal',
        githubLogin: 'frank',
        slackUserId: 'UFRANK',
      });
      expect(deleteUserMapping(db, 'work', 'frank')).toBe(false);
      expect(getUserMapping(db, 'personal', 'frank')).toBeDefined();
    });
  });

  describe('listUserMappings', () => {
    beforeEach(() => {
      upsertUserMapping(db, { workspace: 'work', githubLogin: 'alice', slackUserId: 'UA' });
      upsertUserMapping(db, { workspace: 'work', githubLogin: 'bob', slackUserId: 'UB' });
      upsertUserMapping(db, {
        workspace: 'personal',
        githubLogin: 'alice',
        slackUserId: 'UA-PERSONAL',
      });
    });

    test('returns all rows when no workspace filter provided', () => {
      const rows = listUserMappings(db);
      expect(rows).toHaveLength(3);
    });

    test('filters by workspace when provided', () => {
      const workRows = listUserMappings(db, 'work');
      expect(workRows).toHaveLength(2);
      expect(workRows.every((r) => r.workspace === 'work')).toBe(true);

      const personalRows = listUserMappings(db, 'personal');
      expect(personalRows).toHaveLength(1);
      expect(personalRows[0].slack_user_id).toBe('UA-PERSONAL');
    });

    test('returns rows ordered by workspace then github_login', () => {
      const rows = listUserMappings(db);
      expect(rows.map((r) => [r.workspace, r.github_login])).toEqual([
        ['personal', 'alice'],
        ['work', 'alice'],
        ['work', 'bob'],
      ]);
    });

    test('returns empty array when workspace has no mappings', () => {
      expect(listUserMappings(db, 'nonexistent')).toEqual([]);
    });

    test('returns empty array when no mappings exist at all', () => {
      db.prepare('DELETE FROM slack_user_map').run();
      expect(listUserMappings(db)).toEqual([]);
    });
  });
});
