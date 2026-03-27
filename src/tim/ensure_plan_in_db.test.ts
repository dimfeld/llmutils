import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModuleMocker } from '../testing.js';
import { closeDatabaseForTesting, getDatabase } from './db/database.js';
import { getPlanByUuid, upsertPlan } from './db/plan.js';
import { clearPlanSyncContext } from './db/plan_sync.js';
import { getOrCreateProject } from './db/project.js';
import { clearConfigCache } from './configLoader.js';
import { resolvePlanFromDbOrSyncFile } from './ensure_plan_in_db.js';
import { getRepositoryIdentity } from './assignments/workspace_identifier.js';
import { resolvePlanFromDb } from './plans.js';

const moduleMocker = new ModuleMocker(import.meta);

async function importFreshEnsurePlanInDb(suffix: string) {
  return import(`./ensure_plan_in_db.js?${suffix}-${Date.now()}`);
}

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
      ['---', 'id: 1', 'title: UUID-less plan', 'status: pending', 'tasks: []', '---', '', ''].join(
        '\n'
      )
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
    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('syncs direct file paths into the DB and returns the DB-backed plan', async () => {
    const resolved = await resolvePlanFromDbOrSyncFile(planFile, repoRoot);

    expect(resolved.plan.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(resolved.planPath).toBe(planFile);

    const dbResolved = await resolvePlanFromDb('1', repoRoot);
    expect(dbResolved.plan.uuid).toBe(resolved.plan.uuid);
    expect(dbResolved.plan.title).toBe('UUID-less plan');
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
      filename: '1.plan.md',
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
      filename: '1.plan.md',
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
      filename: '1.plan.md',
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
    const resolvePlanFromDbMock = async (): Promise<never> => {
      throw new Error('database unavailable');
    };

    await moduleMocker.mock('./plans.js', () => ({
      resolvePlanFromDb: resolvePlanFromDbMock,
    }));

    const { resolvePlanFromDbOrSyncFile: resolveWithMock } =
      await importFreshEnsurePlanInDb('db-error');

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

    await expect(resolveWithMock(planFile, repoRoot)).rejects.toThrow('database unavailable');
  });

  test('resolves relative direct file paths against CWD', async () => {
    const originalCwd = process.cwd();

    process.chdir(repoRoot);
    try {
      const resolved = await resolvePlanFromDbOrSyncFile(path.join('tasks', '1.plan.md'), repoRoot);

      expect(resolved.plan.id).toBe(1);
      expect(resolved.planPath).toBe(planFile);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('resolves relative direct file paths against configBaseDir instead of CWD', async () => {
    const otherRepo = path.join(tempDir, 'other-repo');
    const otherPlanFile = path.join(otherRepo, 'tasks', '1.plan.md');
    const originalCwd = process.cwd();

    await fs.mkdir(path.dirname(otherPlanFile), { recursive: true });
    await fs.writeFile(
      otherPlanFile,
      [
        '---',
        'id: 1',
        'title: Wrong repo plan',
        'status: pending',
        'tasks: []',
        '---',
        '',
        '',
      ].join('\n')
    );

    process.chdir(otherRepo);
    try {
      const resolved = await resolvePlanFromDbOrSyncFile(
        path.join('tasks', '1.plan.md'),
        repoRoot,
        repoRoot
      );

      expect(resolved.plan.title).toBe('UUID-less plan');
      expect(resolved.planPath).toBe(planFile);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('resolves relative direct file paths against configBaseDir instead of CWD', async () => {
    const originalCwd = process.cwd();
    const cwdRepo = path.join(tempDir, 'cwd-repo');
    const targetRepo = path.join(tempDir, 'target-repo');
    const cwdPlanPath = path.join(cwdRepo, 'tasks', '1.plan.md');
    const targetPlanPath = path.join(targetRepo, 'tasks', '1.plan.md');

    await fs.mkdir(path.dirname(cwdPlanPath), { recursive: true });
    await fs.mkdir(path.dirname(targetPlanPath), { recursive: true });
    await Bun.$`git init`.cwd(cwdRepo).quiet();
    await Bun.$`git remote add origin https://example.com/test/cwd.git`.cwd(cwdRepo).quiet();
    await Bun.$`git init`.cwd(targetRepo).quiet();
    await Bun.$`git remote add origin https://example.com/test/target.git`.cwd(targetRepo).quiet();

    await fs.writeFile(
      cwdPlanPath,
      ['---', 'id: 1', 'title: CWD plan', 'status: pending', 'tasks: []', '---', '', ''].join('\n')
    );
    await fs.writeFile(
      targetPlanPath,
      [
        '---',
        'id: 1',
        'title: Target repo plan',
        'status: pending',
        'tasks: []',
        '---',
        '',
        '',
      ].join('\n')
    );

    process.chdir(cwdRepo);
    try {
      const resolved = await resolvePlanFromDbOrSyncFile(
        path.join('tasks', '1.plan.md'),
        targetRepo,
        targetRepo
      );

      expect(resolved.plan.title).toBe('Target repo plan');
      expect(resolved.planPath).toBe(targetPlanPath);

      const dbResolved = await resolvePlanFromDb('1', targetRepo, { resolveDir: targetRepo });
      expect(dbResolved.plan.title).toBe('Target repo plan');
      expect(dbResolved.planPath).toBe(targetPlanPath);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
