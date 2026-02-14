import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { openDatabase } from './database.js';
import {
  getOrCreateProject,
  getProject,
  listProjects,
  reserveNextPlanId,
  updateProject,
} from './project.js';

describe('tim db/project', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-project-db-test-'));
    db = openDatabase(path.join(tempDir, 'tim.db'));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('getOrCreateProject creates and returns project', () => {
    const project = getOrCreateProject(db, 'repo-1', {
      remoteUrl: 'https://example.com/repo-1.git',
      lastGitRoot: '/tmp/repo-1',
      externalConfigPath: '/tmp/repo-1/.rmfilter/config/tim.yml',
      externalTasksDir: '/tmp/repo-1/tasks',
      remoteLabel: 'origin/main',
      highestPlanId: 8,
    });

    expect(project.repository_id).toBe('repo-1');
    expect(project.remote_url).toBe('https://example.com/repo-1.git');
    expect(project.highest_plan_id).toBe(8);

    const fetched = getProject(db, 'repo-1');
    expect(fetched?.id).toBe(project.id);
  });

  test('getOrCreateProject returns existing project when already present', () => {
    const first = getOrCreateProject(db, 'repo-1', { highestPlanId: 4 });
    const second = getOrCreateProject(db, 'repo-1', { highestPlanId: 999 });

    expect(second.id).toBe(first.id);
    expect(second.highest_plan_id).toBe(4);
  });

  test('getProject returns null for non-existent repository', () => {
    expect(getProject(db, 'missing-repository')).toBeNull();
  });

  test('getProject returns an existing project by repository id', () => {
    const created = getOrCreateProject(db, 'repo-lookup');
    const fetched = getProject(db, 'repo-lookup');

    expect(fetched?.id).toBe(created.id);
    expect(fetched?.repository_id).toBe('repo-lookup');
  });

  test('updateProject updates only provided fields and refreshes timestamp', () => {
    const created = getOrCreateProject(db, 'repo-1', {
      remoteUrl: 'https://example.com/old.git',
      remoteLabel: 'old-label',
    });
    db.prepare("UPDATE project SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(
      created.id
    );

    const updated = updateProject(db, created.id, {
      remoteUrl: 'https://example.com/new.git',
      remoteLabel: null,
    });

    expect(updated).not.toBeNull();
    expect(updated?.remote_url).toBe('https://example.com/new.git');
    expect(updated?.remote_label).toBeNull();
    expect(updated?.updated_at).not.toBe('2000-01-01T00:00:00.000Z');
  });

  test('updateProject returns current row when no fields provided', () => {
    const created = getOrCreateProject(db, 'repo-1');
    const updated = updateProject(db, created.id, {});

    expect(updated?.id).toBe(created.id);
    expect(updated?.repository_id).toBe('repo-1');
  });

  test('reserveNextPlanId uses current highest when local max is lower', () => {
    getOrCreateProject(db, 'repo-1', { highestPlanId: 5 });

    const reserved = reserveNextPlanId(db, 'repo-1', 3, 2);
    expect(reserved).toEqual({ startId: 6, endId: 7 });

    const project = getProject(db, 'repo-1');
    expect(project?.highest_plan_id).toBe(7);
  });

  test('reserveNextPlanId uses local max when it is higher than current', () => {
    getOrCreateProject(db, 'repo-1', { highestPlanId: 5 });

    const reserved = reserveNextPlanId(db, 'repo-1', 10, 3);
    expect(reserved).toEqual({ startId: 11, endId: 13 });

    const project = getProject(db, 'repo-1');
    expect(project?.highest_plan_id).toBe(13);
  });

  test('reserveNextPlanId returns contiguous ranges across repeated reservations', () => {
    getOrCreateProject(db, 'repo-1', { highestPlanId: 1 });

    const first = reserveNextPlanId(db, 'repo-1', 1, 2);
    const second = reserveNextPlanId(db, 'repo-1', 1, 2);

    expect(first).toEqual({ startId: 2, endId: 3 });
    expect(second).toEqual({ startId: 4, endId: 5 });
  });

  test('reserveNextPlanId handles concurrent access from multiple connections', () => {
    const dbPath = path.join(tempDir, 'tim.db');
    const db2 = openDatabase(dbPath);

    try {
      getOrCreateProject(db, 'concurrent-test');

      const result1 = reserveNextPlanId(db, 'concurrent-test', 0, 5);
      const result2 = reserveNextPlanId(db2, 'concurrent-test', 0, 3);

      expect(result1).toEqual({ startId: 1, endId: 5 });
      expect(result2).toEqual({ startId: 6, endId: 8 });

      const project = getProject(db, 'concurrent-test');
      expect(project?.highest_plan_id).toBe(8);
    } finally {
      db2.close(false);
    }
  });

  test('reserveNextPlanId creates project when missing', () => {
    const reserved = reserveNextPlanId(db, 'repo-new', 4, 1);
    expect(reserved).toEqual({ startId: 5, endId: 5 });

    const project = getProject(db, 'repo-new');
    expect(project).not.toBeNull();
    expect(project?.highest_plan_id).toBe(5);
  });

  test('reserveNextPlanId propagates remote URL when creating project', () => {
    reserveNextPlanId(db, 'repo-with-remote', 0, 1, 'https://example.com/repo.git');
    const project = getProject(db, 'repo-with-remote');
    expect(project?.remote_url).toBe('https://example.com/repo.git');
  });

  test('reserveNextPlanId validates count', () => {
    expect(() => reserveNextPlanId(db, 'repo-1', 0, 0)).toThrow(/positive integer/);
  });

  test('listProjects returns projects ordered by repository_id', () => {
    getOrCreateProject(db, 'repo-c');
    getOrCreateProject(db, 'repo-a');
    getOrCreateProject(db, 'repo-b');

    const projects = listProjects(db);
    expect(projects.map((project) => project.repository_id)).toEqual([
      'repo-a',
      'repo-b',
      'repo-c',
    ]);
  });
});
