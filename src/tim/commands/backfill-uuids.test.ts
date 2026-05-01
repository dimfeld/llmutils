import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Database } from 'bun:sqlite';

import { backfillMissingPlanAndTaskUuids } from './backfill-uuids.js';

describe('backfill-uuids command helpers', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE project (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT,
        repository_id TEXT NOT NULL
      );
      CREATE TABLE plan (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT,
        project_id INTEGER NOT NULL,
        plan_id INTEGER NOT NULL,
        title TEXT
      );
      CREATE TABLE plan_task (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT,
        plan_uuid TEXT NOT NULL,
        task_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0
      );
    `);
  });

  afterEach(() => {
    db.close(false);
  });

  test('backfills NULL project, plan, and task UUIDs', () => {
    db.prepare(`INSERT INTO project (uuid, repository_id) VALUES (NULL, 'repo-null-project')`).run();
    const projectId = (
      db.prepare('SELECT id FROM project WHERE repository_id = ?').get('repo-null-project') as {
        id: number;
      }
    ).id;

    db.prepare(
      `INSERT INTO plan (uuid, project_id, plan_id, title)
       VALUES (NULL, ?, 1, 'Null UUID plan')`
    ).run(projectId);
    db.prepare(
      `INSERT INTO plan (uuid, project_id, plan_id, title)
       VALUES ('11111111-1111-4111-8111-111111111111', ?, 2, 'Existing UUID plan')`
    ).run(projectId);
    db.prepare(
      `INSERT INTO plan_task (uuid, plan_uuid, task_index, title, description, done)
       VALUES (NULL, '11111111-1111-4111-8111-111111111111', 0, 'Null task', 'desc', 0)`
    ).run();

    const result = backfillMissingPlanAndTaskUuids(db);

    expect(result).toEqual({ projectsUpdated: 1, plansUpdated: 1, tasksUpdated: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM project WHERE uuid IS NULL').get()).toEqual({
      count: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM plan WHERE uuid IS NULL').get()).toEqual({
      count: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM plan_task WHERE uuid IS NULL').get()).toEqual({
      count: 0,
    });
  });
});
