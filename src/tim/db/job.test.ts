import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import { listRecentJobs, markJobFinished, recordJobStart } from './job.js';
import { getOrCreateProject } from './project.js';
import { nonSyncedUpsertPlan } from './plan.js';

const PLAN_UUID = '11111111-1111-4111-8111-111111111111';
const PR_URL = 'https://github.com/example/repo/pull/7';

describe('tim db/job', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;
  let otherProjectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-job-db-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
    projectId = getOrCreateProject(db, 'repo-job-1').id;
    otherProjectId = getOrCreateProject(db, 'repo-job-2').id;
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('records a running job and marks it finished', () => {
    const jobId = recordJobStart(db, {
      projectId,
      jobType: 'agent',
      planId: 42,
      planUuid: PLAN_UUID,
      planTitle: 'Build the thing',
      workspacePath: '/tmp/repo',
    });

    let jobs = listRecentJobs(db, { projectId });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: jobId,
      job_type: 'agent',
      plan_id: 42,
      plan_uuid: PLAN_UUID,
      plan_title: 'Build the thing',
      status: 'running',
      finished_at: null,
    });

    markJobFinished(db, jobId, 'completed');
    jobs = listRecentJobs(db, { projectId });
    expect(jobs[0].status).toBe('completed');
    expect(jobs[0].finished_at).not.toBeNull();
  });

  test('marks a job as failed', () => {
    const jobId = recordJobStart(db, { projectId, jobType: 'proof' });
    markJobFinished(db, jobId, 'failed');
    const jobs = listRecentJobs(db, { projectId });
    expect(jobs[0].status).toBe('failed');
  });

  test('filters by project and orders most recent first', () => {
    recordJobStart(db, { projectId, jobType: 'agent' });
    recordJobStart(db, { projectId: otherProjectId, jobType: 'generate' });
    const second = recordJobStart(db, { projectId, jobType: 'proof' });

    const scoped = listRecentJobs(db, { projectId });
    expect(scoped.map((j) => j.job_type)).toEqual(['proof', 'agent']);
    expect(scoped[0].id).toBe(second);

    const all = listRecentJobs(db, { projectId: 'all' });
    expect(all).toHaveLength(3);
  });

  test('respects the limit option', () => {
    for (let i = 0; i < 5; i++) {
      recordJobStart(db, { projectId, jobType: 'agent' });
    }
    expect(listRecentJobs(db, { projectId, limit: 2 })).toHaveLength(2);
  });

  test('enriches plan id and title from the plan table when not stored', () => {
    nonSyncedUpsertPlan(db, projectId, {
      uuid: PLAN_UUID,
      planId: 99,
      title: 'Linked plan',
      goal: 'Goal',
    });

    // Record without plan_id/plan_title; they should be backfilled from the join.
    recordJobStart(db, { projectId, jobType: 'review-guide', planUuid: PLAN_UUID });

    const jobs = listRecentJobs(db, { projectId });
    expect(jobs[0].plan_id).toBe(99);
    expect(jobs[0].plan_title).toBe('Linked plan');
  });

  test('canonicalizes the stored PR url', () => {
    recordJobStart(db, {
      projectId,
      jobType: 'pr-create',
      prUrl: `${PR_URL}/files#discussion`,
    });
    const jobs = listRecentJobs(db, { projectId });
    expect(jobs[0].pr_url).toBe(PR_URL);
  });
});
