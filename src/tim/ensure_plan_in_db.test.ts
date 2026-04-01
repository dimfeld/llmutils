import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDatabaseForTesting, getDatabase } from './db/database.js';
import { getPlanByUuid, upsertPlan } from './db/plan.js';
import { clearPlanSyncContext } from './db/plan_sync.js';
import { getOrCreateProject } from './db/project.js';
import { clearConfigCache } from './configLoader.js';
import { resolvePlanFromDbOrSyncFile } from './ensure_plan_in_db.js';
import { getRepositoryIdentity } from './assignments/workspace_identifier.js';
import * as plans from './plans.js';

describe('resolvePlanFromDbOrSyncFile', () => {
  let tempDir: string;
  let repoRoot: string;
  let planFile: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensure-plan-in-db-test-'));
    repoRoot = path.join(tempDir, 'repo');
    await fs.mkdir(repoRoot, { recursive: true });
    planFile = path.join(repoRoot, 'tasks', '1.plan.md');
    await fs.mkdir(path.dirname(planFile), { recursive: true });

    await Bun.$`git init`.cwd(repoRoot).quiet();
    await Bun.$`git remote add origin https://example.com/test/repo.git`.cwd(repoRoot).quiet();

    await fs.writeFile(
      planFile,
      [
        '---',
        'id: 1',
        'uuid: "11111111-1111-4111-8111-111111111111"',
        'title: Seed plan',
        'status: pending',
        'tasks: []',
        '---',
        '',
        '',
      ].join('\n')
    );

    closeDatabaseForTesting();
    clearPlanSyncContext();
    clearConfigCache();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    clearPlanSyncContext();
    clearConfigCache();
    closeDatabaseForTesting();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('does not overwrite newer DB state with an older direct file path', async () => {
    const repository = await getRepositoryIdentity({ cwd: repoRoot });
    const db = getDatabase();
    const project = getOrCreateProject(db, repository.repositoryId, {
      remoteUrl: repository.remoteUrl,
      lastGitRoot: repository.gitRoot,
    });

    upsertPlan(db, project.id, {
      uuid: '11111111-1111-4111-8111-111111111111',
      planId: 1,
      title: 'Newer title from DB',
      status: 'in_progress',
      tasks: [],
      sourceUpdatedAt: '2026-03-26T12:00:00.000Z',
    });

    await fs.writeFile(
      planFile,
      [
        '---',
        'id: 1',
        'uuid: "11111111-1111-4111-8111-111111111111"',
        'title: Older title from file',
        'status: pending',
        'updatedAt: 2026-03-25T12:00:00.000Z',
        'tasks: []',
        '---',
        '',
        '',
      ].join('\n')
    );

    const resolved = await resolvePlanFromDbOrSyncFile(planFile, repoRoot);

    expect(resolved.plan.title).toBe('Newer title from DB');
    expect(resolved.plan.status).toBe('in_progress');

    const dbRow = getPlanByUuid(db, '11111111-1111-4111-8111-111111111111');
    expect(dbRow?.title).toBe('Newer title from DB');
    expect(dbRow?.status).toBe('in_progress');
  });

  test('updates the DB when the direct file path is newer than the DB row', async () => {
    const repository = await getRepositoryIdentity({ cwd: repoRoot });
    const db = getDatabase();
    const project = getOrCreateProject(db, repository.repositoryId, {
      remoteUrl: repository.remoteUrl,
      lastGitRoot: repository.gitRoot,
    });

    upsertPlan(db, project.id, {
      uuid: '11111111-1111-4111-8111-111111111111',
      planId: 1,
      title: 'Older title from DB',
      status: 'pending',
      tasks: [],
      sourceUpdatedAt: '2026-03-25T12:00:00.000Z',
    });

    await fs.writeFile(
      planFile,
      [
        '---',
        'id: 1',
        'uuid: "11111111-1111-4111-8111-111111111111"',
        'title: Newer title from file',
        'status: done',
        'updatedAt: 2026-03-26T12:00:00.000Z',
        'tasks: []',
        '---',
        '',
        '',
      ].join('\n')
    );

    const resolved = await resolvePlanFromDbOrSyncFile(planFile, repoRoot);

    expect(resolved.plan.title).toBe('Newer title from file');
    expect(resolved.plan.status).toBe('done');

    const dbRow = getPlanByUuid(db, '11111111-1111-4111-8111-111111111111');
    expect(dbRow?.title).toBe('Newer title from file');
    expect(dbRow?.status).toBe('done');
  });

  test('syncs direct files against the imported repo config and tasks context', async () => {
    const hostRepo = path.join(tempDir, 'host-repo');
    const importedRepo = path.join(tempDir, 'imported-repo');
    const importedTasksDir = path.join(importedRepo, 'custom-tasks');
    const importedConfigDir = path.join(importedRepo, '.rmfilter', 'config');
    const importedPlanFile = path.join(importedTasksDir, '1.plan.md');

    await fs.mkdir(hostRepo, { recursive: true });
    await Bun.$`git init`.cwd(hostRepo).quiet();
    await Bun.$`git remote add origin https://example.com/test/host.git`.cwd(hostRepo).quiet();

    await fs.mkdir(importedConfigDir, { recursive: true });
    await fs.mkdir(importedTasksDir, { recursive: true });
    await Bun.$`git init`.cwd(importedRepo).quiet();
    await Bun.$`git remote add origin https://example.com/test/imported.git`
      .cwd(importedRepo)
      .quiet();
    await fs.writeFile(
      path.join(importedConfigDir, 'tim.yml'),
      ['paths:', '  tasks: custom-tasks', ''].join('\n')
    );
    await fs.writeFile(
      path.join(importedTasksDir, '2.plan.md'),
      [
        '---',
        'id: 2',
        'uuid: "22222222-2222-4222-8222-222222222222"',
        'title: Imported dependency',
        'status: pending',
        'tasks: []',
        '---',
        '',
        '',
      ].join('\n')
    );
    await fs.writeFile(
      importedPlanFile,
      [
        '---',
        'id: 1',
        'uuid: "11111111-1111-4111-8111-111111111111"',
        'title: Imported plan',
        'status: pending',
        'dependencies:',
        '  - 2',
        'tasks: []',
        'updatedAt: 2026-03-26T12:00:00.000Z',
        '---',
        '',
        '',
      ].join('\n')
    );

    process.chdir(hostRepo);
    await resolvePlanFromDbOrSyncFile(path.join(importedTasksDir, '2.plan.md'), importedRepo);

    const resolved = await resolvePlanFromDbOrSyncFile(importedPlanFile, importedRepo);

    expect(resolved.plan.uuid).toBe('11111111-1111-4111-8111-111111111111');

    const db = getDatabase();
    const dependencyRows = db
      .prepare('SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ?')
      .all('11111111-1111-4111-8111-111111111111') as Array<{ depends_on_uuid: string }>;
    expect(dependencyRows).toEqual([{ depends_on_uuid: '22222222-2222-4222-8222-222222222222' }]);
  });

  test('prefers the DB plan when a direct file path has no updatedAt but the plan already exists in the DB', async () => {
    const repository = await getRepositoryIdentity({ cwd: repoRoot });
    const db = getDatabase();
    const project = getOrCreateProject(db, repository.repositoryId, {
      remoteUrl: repository.remoteUrl,
      lastGitRoot: repository.gitRoot,
    });

    upsertPlan(db, project.id, {
      uuid: '11111111-1111-4111-8111-111111111111',
      planId: 1,
      title: 'Authoritative title from DB',
      status: 'in_progress',
      tasks: [],
      sourceUpdatedAt: '2026-03-26T12:00:00.000Z',
    });

    await fs.writeFile(
      planFile,
      [
        '---',
        'id: 1',
        'uuid: "11111111-1111-4111-8111-111111111111"',
        'title: Stale title without timestamp',
        'status: pending',
        'tasks: []',
        '---',
        '',
        '',
      ].join('\n')
    );

    const resolved = await resolvePlanFromDbOrSyncFile(planFile, repoRoot);

    expect(resolved.plan.title).toBe('Authoritative title from DB');
    expect(resolved.plan.status).toBe('in_progress');

    const dbRow = getPlanByUuid(db, '11111111-1111-4111-8111-111111111111');
    expect(dbRow?.title).toBe('Authoritative title from DB');
    expect(dbRow?.status).toBe('in_progress');
  });

  test('propagates sync errors instead of swallowing them', async () => {
    await fs.writeFile(
      planFile,
      [
        '---',
        'id: 1',
        'uuid: "11111111-1111-4111-8111-111111111111"',
        'title: Plan with sync failure',
        'status: pending',
        'updatedAt: 2026-03-26T12:00:00.000Z',
        'tasks: []',
        '---',
        '',
        '',
      ].join('\n')
    );

    await expect(
      resolvePlanFromDbOrSyncFile(planFile, path.join(tempDir, 'missing-repo-root'))
    ).rejects.toThrow();
  });

  test('rethrows non-plan-not-found errors when resolving a timestamp-less file-backed plan', async () => {
    const resolvePlanSpy = vi
      .spyOn(plans, 'resolvePlanFromDb')
      .mockRejectedValue(new Error('database unavailable'));

    await fs.writeFile(
      planFile,
      [
        '---',
        'id: 1',
        'uuid: "11111111-1111-4111-8111-111111111111"',
        'title: Plan without updatedAt',
        'status: pending',
        'tasks: []',
        '---',
        '',
        '',
      ].join('\n')
    );

    try {
      await expect(resolvePlanFromDbOrSyncFile(planFile, repoRoot)).rejects.toThrow(
        'database unavailable'
      );
    } finally {
      resolvePlanSpy.mockRestore();
    }
  });
});
