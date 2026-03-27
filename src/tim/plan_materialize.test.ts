import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModuleMocker, clearAllTimCaches } from '../testing.js';
import { getRepositoryIdentity } from './assignments/workspace_identifier.js';
import { closeDatabaseForTesting, getDatabase } from './db/database.js';
import {
  getPlanByPlanId,
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlanTagsByUuid,
  getPlanTasksByUuid,
  upsertPlan,
} from './db/plan.js';
import { clearPlanSyncContext } from './db/plan_sync.js';
import { getOrCreateProject } from './db/project.js';
import {
  cleanupMaterializedPlans,
  ensureMaterializeDir,
  getMaterializedPlanPath,
  materializePlan,
  materializeRelatedPlans,
  resolveProjectContext,
  syncMaterializedPlan,
  withPlanAutoSync,
} from './plan_materialize.js';
import { readPlanFile, writePlanFile } from './plans.js';
import { handleCleanupMaterializedCommand } from './commands/cleanup-materialized.js';
import { handleMaterializeCommand } from './commands/materialize.js';
import { handleSyncCommand } from './commands/sync.js';

const moduleMocker = new ModuleMocker(import.meta);

async function importFreshPlanMaterialize(suffix: string) {
  return import(`./plan_materialize.js?${suffix}-${Date.now()}`);
}

async function initializeGitRepository(repoDir: string): Promise<void> {
  await Bun.$`git init`.cwd(repoDir).quiet();
  await Bun.$`git remote add origin https://example.com/acme/materialize-tests.git`
    .cwd(repoDir)
    .quiet();
}

describe('tim plan_materialize', () => {
  let tempDir: string;
  let repoDir: string;
  let originalXdgConfigHome: string | undefined;
  let originalGitConfigGlobal: string | undefined;

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-materialize-test-'));
    repoDir = path.join(tempDir, 'repo');
    await fs.mkdir(repoDir, { recursive: true });
    await initializeGitRepository(repoDir);

    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg');
    originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = path.join(tempDir, 'gitconfig-global');
    await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, '', 'utf8');
  });

  afterEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    moduleMocker.clear();

    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }

    if (originalGitConfigGlobal === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function seedProject() {
    const repository = await getRepositoryIdentity({ cwd: repoDir });
    const db = getDatabase();
    const project = getOrCreateProject(db, repository.repositoryId, {
      remoteUrl: repository.remoteUrl,
      lastGitRoot: repository.gitRoot,
    });

    upsertPlan(db, project.id, {
      uuid: '11111111-1111-4111-8111-111111111111',
      planId: 1,
      title: 'Parent plan',
      goal: 'Parent goal',
      details: 'Parent details',
      filename: '1-parent.plan.md',
      tasks: [{ title: 'parent task', description: 'parent task', done: false }],
      tags: ['parent'],
    });
    upsertPlan(db, project.id, {
      uuid: '22222222-2222-4222-8222-222222222222',
      planId: 2,
      title: 'Dependency plan',
      goal: 'Dependency goal',
      details: 'Dependency details',
      filename: '2-dependency.plan.md',
      tasks: [{ title: 'dep task', description: 'dep task', done: true }],
      tags: ['dependency'],
    });
    upsertPlan(db, project.id, {
      uuid: '33333333-3333-4333-8333-333333333333',
      planId: 3,
      title: 'Primary plan',
      goal: 'Primary goal',
      details: 'Primary details',
      status: 'in_progress',
      priority: 'high',
      branch: 'feature/materialize',
      simple: true,
      tdd: true,
      discoveredFrom: 99,
      issue: ['https://github.com/example/repo/issues/3'],
      pullRequest: ['https://github.com/example/repo/pull/30'],
      assignedTo: 'dimfeld',
      baseBranch: 'main',
      temp: true,
      docs: ['docs/primary.md'],
      changedFiles: ['src/tim/plan_materialize.ts'],
      planGeneratedAt: '2026-03-01T00:00:00.000Z',
      reviewIssues: [
        {
          severity: 'major',
          category: 'coverage',
          content: 'Need round-trip test',
          file: 'src/tim/plan_materialize.ts',
          line: 1,
        },
      ],
      parentUuid: '11111111-1111-4111-8111-111111111111',
      epic: false,
      filename: '3-primary.plan.md',
      tasks: [
        { title: 'implement', description: 'build materialize flow', done: false },
        { title: 'verify', description: 'run tests', done: false },
      ],
      dependencyUuids: ['22222222-2222-4222-8222-222222222222'],
      tags: ['materialize', 'sync'],
    });
    upsertPlan(db, project.id, {
      uuid: '44444444-4444-4444-8444-444444444444',
      planId: 4,
      title: 'Child plan',
      goal: 'Child goal',
      details: 'Child details',
      parentUuid: '33333333-3333-4333-8333-333333333333',
      filename: '4-child.plan.md',
    });
    upsertPlan(db, project.id, {
      uuid: '55555555-5555-4555-8555-555555555555',
      planId: 5,
      title: 'Sibling plan',
      goal: 'Sibling goal',
      details: 'Sibling details',
      parentUuid: '11111111-1111-4111-8111-111111111111',
      filename: '5-sibling.plan.md',
    });

    return { db, project };
  }

  test('materializePlan writes the primary plan and materializeRelatedPlans writes references', async () => {
    await seedProject();

    const materializeDir = await ensureMaterializeDir(repoDir);
    const infoExcludePath = path.join(repoDir, '.git', 'info', 'exclude');
    expect(await fs.readFile(infoExcludePath, 'utf8')).toContain('.tim/plans\n');
    await expect(fs.access(path.join(materializeDir, '.gitignore'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const planPath = await materializePlan(3, repoDir);
    expect(planPath).toBe(getMaterializedPlanPath(repoDir, 3));

    const materializedPlan = await readPlanFile(planPath);
    expect(materializedPlan).toMatchObject({
      id: 3,
      uuid: '33333333-3333-4333-8333-333333333333',
      title: 'Primary plan',
      goal: 'Primary goal',
      details: 'Primary details',
      status: 'in_progress',
      priority: 'high',
      branch: 'feature/materialize',
      simple: true,
      tdd: true,
      discoveredFrom: 99,
      issue: ['https://github.com/example/repo/issues/3'],
      pullRequest: ['https://github.com/example/repo/pull/30'],
      assignedTo: 'dimfeld',
      baseBranch: 'main',
      temp: true,
      docs: ['docs/primary.md'],
      changedFiles: ['src/tim/plan_materialize.ts'],
      planGeneratedAt: '2026-03-01T00:00:00.000Z',
      parent: 1,
      dependencies: [2],
      tags: ['materialize', 'sync'],
      materializedAs: 'primary',
    });
    expect(materializedPlan.tasks).toHaveLength(2);
    expect(materializedPlan.reviewIssues).toHaveLength(1);

    const refPaths = await materializeRelatedPlans(3, repoDir);
    expect(refPaths.sort()).toEqual(
      [
        getMaterializedPlanPath(repoDir, 1),
        getMaterializedPlanPath(repoDir, 2),
        getMaterializedPlanPath(repoDir, 4),
        getMaterializedPlanPath(repoDir, 5),
      ].sort()
    );

    const parentRef = await readPlanFile(getMaterializedPlanPath(repoDir, 1));
    const dependencyRef = await readPlanFile(getMaterializedPlanPath(repoDir, 2));
    const childRef = await readPlanFile(getMaterializedPlanPath(repoDir, 4));
    const siblingRef = await readPlanFile(getMaterializedPlanPath(repoDir, 5));

    expect(parentRef.title).toBe('Parent plan');
    expect(parentRef.materializedAs).toBe('reference');
    expect(dependencyRef.title).toBe('Dependency plan');
    expect(dependencyRef.materializedAs).toBe('reference');
    expect(childRef.parent).toBe(3);
    expect(childRef.materializedAs).toBe('reference');
    expect(siblingRef.parent).toBe(1);
    expect(siblingRef.materializedAs).toBe('reference');
  });

  test('materializeRelatedPlans does not overwrite an existing primary materialized plan', async () => {
    await seedProject();

    const dependencyPlanPath = await materializePlan(2, repoDir);
    const editedDependencyPlan = await readPlanFile(dependencyPlanPath);
    editedDependencyPlan.title = 'Dependency plan preserved from primary file';
    editedDependencyPlan.details = 'Primary edits should survive related materialization';
    await writePlanFile(dependencyPlanPath, editedDependencyPlan, { skipSync: true });

    const writtenPaths = await materializeRelatedPlans(3, repoDir);

    expect(writtenPaths).not.toContain(dependencyPlanPath);

    const preservedDependencyPlan = await readPlanFile(dependencyPlanPath);
    expect(preservedDependencyPlan.title).toBe('Dependency plan preserved from primary file');
    expect(preservedDependencyPlan.details).toBe(
      'Primary edits should survive related materialization'
    );
    expect(preservedDependencyPlan.materializedAs).toBe('primary');
  });

  test('materializeRelatedPlans overwrites an existing reference materialized plan with fresh DB content', async () => {
    const { db, project } = await seedProject();
    upsertPlan(db, project.id, {
      uuid: '66666666-6666-4666-8666-666666666666',
      planId: 6,
      title: 'Second dependent plan',
      goal: 'Exercise reference overwrite',
      details: 'Initial dependent details',
      status: 'pending',
      filename: '6-second-dependent.plan.md',
      dependencyUuids: ['22222222-2222-4222-8222-222222222222'],
      tasks: [{ title: 'reuse dep', description: 'share dependency 2', done: false }],
    });

    const firstWrittenPaths = await materializeRelatedPlans(3, repoDir);
    const dependencyPlanPath = getMaterializedPlanPath(repoDir, 2);
    expect(firstWrittenPaths).toContain(dependencyPlanPath);

    db.prepare(
      'UPDATE plan SET title = ?, details = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?'
    ).run(
      'Dependency plan refreshed from DB',
      'Updated dependency details from DB',
      '2026-03-26T00:00:00.000Z',
      project.id,
      2
    );

    const secondWrittenPaths = await materializeRelatedPlans(6, repoDir);
    expect(secondWrittenPaths).toContain(dependencyPlanPath);

    const refreshedDependencyPlan = await readPlanFile(dependencyPlanPath);
    expect(refreshedDependencyPlan.title).toBe('Dependency plan refreshed from DB');
    expect(refreshedDependencyPlan.details).toBe('Updated dependency details from DB');
    expect(refreshedDependencyPlan.materializedAs).toBe('reference');
  });

  test('ensureMaterializeDir does not duplicate .tim/plans in .git/info/exclude', async () => {
    const infoExcludePath = path.join(repoDir, '.git', 'info', 'exclude');
    await fs.appendFile(infoExcludePath, '\n.tim/plans\n');

    await ensureMaterializeDir(repoDir);

    const lines = (await fs.readFile(infoExcludePath, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.filter((line) => line === '.tim/plans')).toHaveLength(1);
  });

  test('ensureMaterializeDir skips updating .git/info/exclude when core.excludesfile already ignores .tim/plans', async () => {
    const globalExcludePath = path.join(tempDir, 'global-gitignore');
    await fs.writeFile(globalExcludePath, '.tim/plans\n', 'utf8');
    await Bun.$`git config core.excludesfile ${globalExcludePath}`.cwd(repoDir).quiet();
    const infoExcludePath = path.join(repoDir, '.git', 'info', 'exclude');
    const before = await fs.readFile(infoExcludePath, 'utf8');

    const materializeDir = await ensureMaterializeDir(repoDir);

    expect(materializeDir).toBe(path.join(repoDir, '.tim', 'plans'));
    expect(await fs.readFile(infoExcludePath, 'utf8')).toBe(before);
    await expect(fs.access(path.join(materializeDir, '.gitignore'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('resolveProjectContext includes the max numeric plan id', async () => {
    await seedProject();

    const context = await resolveProjectContext(repoDir);
    expect(context.maxNumericId).toBe(5);
  });

  test('syncMaterializedPlan syncs edited materialized files back into the database', async () => {
    const { db, project } = await seedProject();
    const planPath = await materializePlan(3, repoDir);

    const editedPlan = await readPlanFile(planPath);
    editedPlan.title = 'Primary plan edited on disk';
    editedPlan.details = 'Primary details updated from file';
    editedPlan.temp = undefined;
    editedPlan.docs = ['docs/primary.md', 'docs/edited.md'];
    editedPlan.changedFiles = ['src/tim/plan_materialize.ts', 'src/tim/plan_materialize.test.ts'];
    editedPlan.reviewIssues = [
      {
        severity: 'minor',
        category: 'correctness',
        content: 'Updated review issue from materialized file',
        file: 'src/tim/plan_materialize.test.ts',
        line: 1,
      },
    ];
    editedPlan.tags = ['materialize', 'verified'];
    editedPlan.dependencies = [1, 2];
    editedPlan.tasks.push({
      title: 'sync changes',
      description: 'persist file edits',
      done: true,
    });
    await writePlanFile(planPath, editedPlan, { skipSync: true });

    await syncMaterializedPlan(3, repoDir);

    const saved = getPlanByPlanId(db, project.id, 3);
    expect(saved?.title).toBe('Primary plan edited on disk');
    expect(saved?.details).toBe('Primary details updated from file');
    expect(saved?.filename).toBe('3-primary.plan.md');
    expect(saved?.temp).toBe(0);
    expect(saved?.docs).toBe('["docs/primary.md","docs/edited.md"]');
    expect(saved?.changed_files).toBe(
      '["src/tim/plan_materialize.ts","src/tim/plan_materialize.test.ts"]'
    );
    expect(saved?.review_issues).toBe(
      '[{"severity":"minor","category":"correctness","content":"Updated review issue from materialized file","file":"src/tim/plan_materialize.test.ts","line":1}]'
    );

    const tasks = getPlanTasksByUuid(db, '33333333-3333-4333-8333-333333333333');
    expect(tasks).toHaveLength(3);
    expect(tasks[2]?.title).toBe('sync changes');

    const tags = getPlanTagsByUuid(db, '33333333-3333-4333-8333-333333333333');
    expect(tags.map((tag) => tag.tag)).toEqual(['materialize', 'verified']);

    const deps = getPlanDependenciesByUuid(db, '33333333-3333-4333-8333-333333333333');
    expect(deps.map((dependency) => dependency.depends_on_uuid)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);

    await materializePlan(3, repoDir);
    const rematerializedPlan = await readPlanFile(planPath);
    expect(rematerializedPlan).toMatchObject({
      title: 'Primary plan edited on disk',
      details: 'Primary details updated from file',
      docs: ['docs/primary.md', 'docs/edited.md'],
      changedFiles: ['src/tim/plan_materialize.ts', 'src/tim/plan_materialize.test.ts'],
      reviewIssues: [
        {
          severity: 'minor',
          category: 'correctness',
          content: 'Updated review issue from materialized file',
          file: 'src/tim/plan_materialize.test.ts',
          line: 1,
        },
      ],
      tags: ['materialize', 'verified'],
      dependencies: [1, 2],
      temp: false,
      materializedAs: 'primary',
    });
  });

  test('withPlanAutoSync syncs file edits before DB changes and re-materializes after', async () => {
    const { db, project } = await seedProject();
    const planPath = await materializePlan(3, repoDir);

    const editedPlan = await readPlanFile(planPath);
    editedPlan.title = 'Title from materialized file';
    await writePlanFile(planPath, editedPlan, { skipSync: true });

    await withPlanAutoSync(3, repoDir, async () => {
      const syncedRow = getPlanByPlanId(db, project.id, 3);
      expect(syncedRow?.title).toBe('Title from materialized file');

      db.prepare('UPDATE plan SET status = ?, updated_at = ? WHERE uuid = ?').run(
        'done',
        '2026-03-24T00:00:00.000Z',
        '33333333-3333-4333-8333-333333333333'
      );
    });

    const saved = getPlanByUuid(db, '33333333-3333-4333-8333-333333333333');
    expect(saved?.title).toBe('Title from materialized file');
    expect(saved?.status).toBe('done');

    const rematerializedPlan = await readPlanFile(planPath);
    expect(rematerializedPlan.title).toBe('Title from materialized file');
    expect(rematerializedPlan.status).toBe('done');
  });

  test('materializePlan throws when the plan does not exist in the repo project', async () => {
    await seedProject();

    await expect(materializePlan(999, repoDir)).rejects.toThrow(
      `Plan 999 was not found in the database for ${repoDir}`
    );
  });

  test('syncMaterializedPlan rejects when the materialized file plan ID does not match the requested ID', async () => {
    await seedProject();
    const planPath = await materializePlan(3, repoDir);

    const mismatchedPlan = await readPlanFile(planPath);
    mismatchedPlan.id = 30;
    await writePlanFile(planPath, mismatchedPlan, { skipSync: true });

    await expect(syncMaterializedPlan(3, repoDir)).rejects.toThrow(
      `Materialized plan path ${planPath} contains plan ID 30, expected 3`
    );
  });

  test('syncMaterializedPlan rejects when the materialized file UUID does not match the DB row', async () => {
    await seedProject();
    const planPath = await materializePlan(3, repoDir);

    const mismatchedPlan = await readPlanFile(planPath);
    mismatchedPlan.uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await writePlanFile(planPath, mismatchedPlan, { skipSync: true });

    await expect(syncMaterializedPlan(3, repoDir)).rejects.toThrow(
      `Materialized plan at ${planPath} contains UUID aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa, expected 33333333-3333-4333-8333-333333333333`
    );
  });

  test('syncMaterializedPlan accepts quoted UUID frontmatter values with inline comments', async () => {
    const { db, project } = await seedProject();
    const planPath = await materializePlan(3, repoDir);

    const content = await fs.readFile(planPath, 'utf8');
    await fs.writeFile(
      planPath,
      content.replace(
        /^uuid: .*$/m,
        'uuid: "33333333-3333-4333-8333-333333333333" # preserve comment handling'
      )
    );

    await syncMaterializedPlan(3, repoDir);

    expect(getPlanByPlanId(db, project.id, 3)?.uuid).toBe('33333333-3333-4333-8333-333333333333');
  });

  test('syncMaterializedPlan does not overwrite newer DB state with a stale materialized file', async () => {
    const { db, project } = await seedProject();
    const planPath = await materializePlan(3, repoDir);

    const stalePlan = await readPlanFile(planPath);
    stalePlan.title = 'Older title from materialized file';
    stalePlan.updatedAt = '2026-03-24T00:00:00.000Z';
    await writePlanFile(planPath, stalePlan, { skipDb: true, skipUpdatedAt: true });

    db.prepare(
      'UPDATE plan SET title = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?'
    ).run('Newer title from DB', '2026-03-25T00:00:00.000Z', project.id, 3);

    await syncMaterializedPlan(3, repoDir);

    expect(getPlanByPlanId(db, project.id, 3)?.title).toBe('Newer title from DB');
  });

  test('syncMaterializedPlan skips file-to-DB sync when the materialized file is missing updatedAt', async () => {
    const { db, project } = await seedProject();
    const planPath = await materializePlan(3, repoDir);

    const stalePlan = await readPlanFile(planPath);
    stalePlan.title = 'Title from timestamp-less materialized file';
    stalePlan.updatedAt = undefined;
    await writePlanFile(planPath, stalePlan, { skipDb: true, skipUpdatedAt: true });

    db.prepare(
      'UPDATE plan SET title = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?'
    ).run('Authoritative title from DB', '2026-03-25T00:00:00.000Z', project.id, 3);

    const returnedPath = await syncMaterializedPlan(3, repoDir);

    expect(returnedPath).toBe(planPath);
    expect(getPlanByPlanId(db, project.id, 3)?.title).toBe('Authoritative title from DB');
  });

  test('syncMaterializedPlan updates the DB when the materialized file is newer', async () => {
    const { db, project } = await seedProject();
    const planPath = await materializePlan(3, repoDir);

    db.prepare(
      'UPDATE plan SET title = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?'
    ).run('Older title from DB', '2026-03-24T00:00:00.000Z', project.id, 3);

    const newerPlan = await readPlanFile(planPath);
    newerPlan.title = 'Newer title from materialized file';
    newerPlan.updatedAt = '2026-03-25T00:00:00.000Z';
    await writePlanFile(planPath, newerPlan, { skipDb: true, skipUpdatedAt: true });

    await syncMaterializedPlan(3, repoDir);

    const saved = getPlanByPlanId(db, project.id, 3);
    expect(saved?.title).toBe('Newer title from materialized file');
  });

  test('withPlanAutoSync does not materialize a file when none exists yet', async () => {
    const { db, project } = await seedProject();
    const planPath = getMaterializedPlanPath(repoDir, 3);

    expect(await Bun.file(planPath).exists()).toBe(false);

    await withPlanAutoSync(3, repoDir, async () => {
      db.prepare(
        'UPDATE plan SET status = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?'
      ).run('cancelled', '2026-03-24T00:00:00.000Z', project.id, 3);
    });

    const saved = getPlanByPlanId(db, project.id, 3);
    expect(saved?.status).toBe('cancelled');
    expect(await Bun.file(planPath).exists()).toBe(false);
  });

  test('withPlanAutoSync re-materializes even when the wrapped operation throws', async () => {
    const { db, project } = await seedProject();
    const planPath = await materializePlan(3, repoDir);

    const editedPlan = await readPlanFile(planPath);
    editedPlan.title = 'Title from materialized file';
    await writePlanFile(planPath, editedPlan, { skipSync: true });

    await expect(
      withPlanAutoSync(3, repoDir, async () => {
        db.prepare(
          'UPDATE plan SET status = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?'
        ).run('done', '2026-03-24T00:00:00.000Z', project.id, 3);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const rematerializedPlan = await readPlanFile(planPath);
    expect(rematerializedPlan.title).toBe('Title from materialized file');
    expect(rematerializedPlan.status).toBe('done');
  });

  test('cleanupMaterializedPlans removes stale primary files and orphaned reference files', async () => {
    const { db, project } = await seedProject();

    const activePlanPath = await materializePlan(3, repoDir);
    const donePlanPath = await materializePlan(2, repoDir);
    const orphanRefPath = getMaterializedPlanPath(repoDir, 999);
    await writePlanFile(
      orphanRefPath,
      {
        id: 999,
        uuid: '99999999-9999-4999-8999-999999999999',
        title: 'Orphan reference',
        filename: '999.plan.md',
        tasks: [],
        materializedAs: 'reference',
      },
      { skipDb: true }
    );

    db.prepare(
      'UPDATE plan SET status = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?'
    ).run('done', '2026-03-24T00:00:00.000Z', project.id, 2);

    const result = await cleanupMaterializedPlans(repoDir);

    // Plan 2 is still needed as a reference by active plan 3 (dependency),
    // so cleanup deletes the stale primary file and re-materializes a fresh reference.
    expect(result.deletedPrimaryFiles).toEqual([donePlanPath]);
    expect(result.deletedReferenceFiles).toEqual([orphanRefPath]);
    expect(await Bun.file(activePlanPath).exists()).toBe(true);
    expect(await Bun.file(donePlanPath).exists()).toBe(true);
    const donePlan = await readPlanFile(donePlanPath);
    expect(donePlan.materializedAs).toBe('reference');
    expect(donePlan.title).toBe('Dependency plan');
    expect(donePlan.details).toBe('Dependency details');
    expect(await Bun.file(orphanRefPath).exists()).toBe(false);
    expect(getPlanByPlanId(db, project.id, 2)?.status).toBe('done');
  });

  test('syncMaterializedPlan refreshes related references and removes stale dependency references', async () => {
    await seedProject();
    const planPath = await materializePlan(3, repoDir);
    await materializeRelatedPlans(3, repoDir);

    const removedDependencyRef = getMaterializedPlanPath(repoDir, 2);
    const addedParentRef = getMaterializedPlanPath(repoDir, 1);
    expect(await Bun.file(removedDependencyRef).exists()).toBe(true);

    const editedPlan = await readPlanFile(planPath);
    editedPlan.dependencies = [];
    await writePlanFile(planPath, editedPlan, { skipSync: true });

    await syncMaterializedPlan(3, repoDir);

    expect(await Bun.file(removedDependencyRef).exists()).toBe(false);
    expect(await Bun.file(addedParentRef).exists()).toBe(true);
    expect(await Bun.file(getMaterializedPlanPath(repoDir, 4)).exists()).toBe(true);
    expect(await Bun.file(getMaterializedPlanPath(repoDir, 5)).exists()).toBe(true);
  });

  test('cleanupMaterializedPlans keeps reference files for existing plans', async () => {
    await seedProject();
    await materializePlan(3, repoDir);
    const refPaths = await materializeRelatedPlans(3, repoDir);

    const result = await cleanupMaterializedPlans(repoDir);

    expect(result.deletedPrimaryFiles).toEqual([]);
    expect(result.deletedReferenceFiles).toEqual([]);
    expect(await Bun.file(refPaths[0]!).exists()).toBe(true);
  });

  test('cleanupMaterializedPlans removes cancelled and orphaned plan files while preserving active files', async () => {
    const { db, project } = await seedProject();

    const activePlanPath = await materializePlan(3, repoDir);
    const cancelledPlanPath = await materializePlan(4, repoDir);
    const orphanPlanPath = getMaterializedPlanPath(repoDir, 999);
    const validRefPath = getMaterializedPlanPath(repoDir, 1);
    await writePlanFile(
      orphanPlanPath,
      {
        id: 999,
        uuid: '99999999-9999-4999-8999-999999999999',
        title: 'Orphaned materialized plan',
        filename: '999.plan.md',
        tasks: [],
      },
      { skipDb: true }
    );
    await materializePlan(1, repoDir);
    await materializeRelatedPlans(3, repoDir);

    db.prepare(
      'UPDATE plan SET status = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?'
    ).run('cancelled', '2026-03-24T00:00:00.000Z', project.id, 4);

    const result = await cleanupMaterializedPlans(repoDir);

    // Plan 4 is cancelled but still needed as a reference by plan 3 (child),
    // so cleanup deletes the stale primary file and re-materializes a fresh reference.
    expect(result.deletedPrimaryFiles.sort()).toEqual([cancelledPlanPath, orphanPlanPath].sort());
    expect(result.deletedReferenceFiles).toEqual([]);
    expect(await Bun.file(activePlanPath).exists()).toBe(true);
    expect(await Bun.file(cancelledPlanPath).exists()).toBe(true);
    const cancelledPlan = await readPlanFile(cancelledPlanPath);
    expect(cancelledPlan.materializedAs).toBe('reference');
    expect(cancelledPlan.title).toBe('Child plan');
    expect(cancelledPlan.details).toBe('Child details');
    expect(await Bun.file(orphanPlanPath).exists()).toBe(false);
    expect(await Bun.file(validRefPath).exists()).toBe(true);
    expect(getPlanByPlanId(db, project.id, 4)?.status).toBe('cancelled');
  });

  test('cleanupMaterializedPlans removes orphaned reference files after deleting a materialized plan', async () => {
    const { db, project } = await seedProject();

    const planPath = await materializePlan(3, repoDir);
    const refPaths = await materializeRelatedPlans(3, repoDir);
    expect(refPaths).toHaveLength(4);

    db.prepare(
      'UPDATE plan SET status = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?'
    ).run('done', '2026-03-24T00:00:00.000Z', project.id, 3);

    const result = await cleanupMaterializedPlans(repoDir);

    expect(result.deletedPrimaryFiles).toEqual([planPath]);
    expect(result.deletedReferenceFiles.sort()).toEqual(refPaths.sort());
    expect(await Bun.file(planPath).exists()).toBe(false);
    for (const refPath of refPaths) {
      expect(await Bun.file(refPath).exists()).toBe(false);
    }
  });

  test('cleanupMaterializedPlans returns empty results when the materialized directory is missing', async () => {
    await seedProject();

    const result = await cleanupMaterializedPlans(repoDir);

    expect(result).toEqual({
      deletedPrimaryFiles: [],
      deletedReferenceFiles: [],
    });
  });

  test('cleanupMaterializedPlans tolerates ENOENT when a stale file disappears before unlink', async () => {
    const { db, project } = await seedProject();
    const stalePlanPath = await materializePlan(4, repoDir);

    db.prepare(
      'UPDATE plan SET status = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?'
    ).run('cancelled', '2026-03-24T00:00:00.000Z', project.id, 4);

    const realFs = await import('node:fs/promises');
    const mockedUnlink = mock(async (entryPath: string) => {
      if (entryPath === stalePlanPath) {
        const error = new Error('already removed') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }

      await realFs.unlink(entryPath);
    });
    await moduleMocker.mock('node:fs/promises', () => ({
      ...realFs,
      unlink: mockedUnlink,
    }));

    const { cleanupMaterializedPlans: cleanupWithMock } =
      await importFreshPlanMaterialize('cleanup-enoent');
    const result = await cleanupWithMock(repoDir);

    expect(result.deletedPrimaryFiles).toContain(stalePlanPath);
    expect(mockedUnlink).toHaveBeenCalledWith(stalePlanPath);
  });

  test('withPlanAutoSync limits repository identity lookups to the wrapper and syncPlanToDb', async () => {
    const { db, project } = await seedProject();
    await materializePlan(3, repoDir);

    const workspaceIdentifier = await import('./assignments/workspace_identifier.js');
    const originalGetRepositoryIdentity = workspaceIdentifier.getRepositoryIdentity;
    const mockedGetRepositoryIdentity = mock(
      async (options?: Parameters<typeof workspaceIdentifier.getRepositoryIdentity>[0]) =>
        originalGetRepositoryIdentity(options)
    );
    await moduleMocker.mock('./assignments/workspace_identifier.js', () => ({
      ...workspaceIdentifier,
      getRepositoryIdentity: mockedGetRepositoryIdentity,
    }));

    const { withPlanAutoSync: withPlanAutoSyncFresh } =
      await importFreshPlanMaterialize('auto-sync-identity');
    await withPlanAutoSyncFresh(3, repoDir, async () => {
      db.prepare(
        'UPDATE plan SET status = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?'
      ).run('done', '2026-03-24T00:00:00.000Z', project.id, 3);
    });

    expect(mockedGetRepositoryIdentity).toHaveBeenCalledTimes(2);
  });

  test('materialize, sync, and cleanup-materialized command handlers work together', async () => {
    const { db, project } = await seedProject();
    const originalCwd = process.cwd();

    try {
      process.chdir(repoDir);

      await handleMaterializeCommand('3', {}, {} as any);

      const planPath = getMaterializedPlanPath(repoDir, 3);
      const dependencyRefPath = getMaterializedPlanPath(repoDir, 2);
      expect(await Bun.file(planPath).exists()).toBe(true);
      expect(await Bun.file(dependencyRefPath).exists()).toBe(true);
      expect((await readPlanFile(planPath)).materializedAs).toBe('primary');
      expect((await readPlanFile(dependencyRefPath)).materializedAs).toBe('reference');

      const editedPlan = await readPlanFile(planPath);
      editedPlan.title = 'Edited via command flow';
      await writePlanFile(planPath, editedPlan, { skipSync: true });

      await handleSyncCommand('3', {}, {} as any);
      const syncedPlan = getPlanByPlanId(db, project.id, 3);
      expect(syncedPlan?.title).toBe('Edited via command flow');
      expect(syncedPlan?.filename).toBe('3-primary.plan.md');

      db.prepare(
        'UPDATE plan SET status = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?'
      ).run('done', '2026-03-24T00:00:00.000Z', project.id, 3);

      await handleCleanupMaterializedCommand({}, {} as any);
      expect(await Bun.file(planPath).exists()).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('materialize, sync, and rematerialize preserve all schema-backed fields through a round trip', async () => {
    const { db, project } = await seedProject();
    const planPath = await materializePlan(3, repoDir);

    const editedPlan = await readPlanFile(planPath);
    editedPlan.title = 'Primary plan round-tripped';
    editedPlan.goal = 'Updated primary goal';
    editedPlan.details = 'Updated primary details';
    editedPlan.status = 'done';
    editedPlan.priority = 'medium';
    editedPlan.branch = 'feature/round-trip';
    editedPlan.simple = false;
    editedPlan.tdd = false;
    editedPlan.discoveredFrom = 101;
    editedPlan.issue = [
      'https://github.com/example/repo/issues/3',
      'https://github.com/example/repo/issues/7',
    ];
    editedPlan.pullRequest = ['https://github.com/example/repo/pull/31'];
    editedPlan.assignedTo = 'qa-agent';
    editedPlan.baseBranch = 'develop';
    editedPlan.temp = false;
    editedPlan.docs = ['docs/primary.md', 'docs/round-trip.md'];
    editedPlan.changedFiles = [
      'src/tim/plan_materialize.ts',
      'src/tim/plan_materialize.test.ts',
      'src/tim/commands/materialize.ts',
    ];
    editedPlan.planGeneratedAt = '2026-03-24T00:00:00.000Z';
    editedPlan.reviewIssues = [
      {
        severity: 'critical',
        category: 'correctness',
        content: 'Round-trip coverage must preserve review findings',
        file: 'src/tim/plan_materialize.ts',
        line: 42,
      },
      {
        severity: 'minor',
        category: 'coverage',
        content: 'Verify cleanup cases',
        file: 'src/tim/plan_materialize.test.ts',
        line: 1,
      },
    ];
    editedPlan.parent = 1;
    editedPlan.dependencies = [1, 2];
    editedPlan.tags = ['materialize', 'round-trip', 'verified'];
    editedPlan.tasks = [
      { title: 'rewrite', description: 'exercise every field', done: true },
      { title: 'verify', description: 'read back from DB and disk', done: false },
    ];
    await writePlanFile(planPath, editedPlan, { skipSync: true });

    await syncMaterializedPlan(3, repoDir);
    await materializePlan(3, repoDir);

    const saved = getPlanByPlanId(db, project.id, 3);
    expect(saved).toMatchObject({
      title: 'Primary plan round-tripped',
      goal: 'Updated primary goal',
      details: 'Updated primary details',
      status: 'done',
      priority: 'medium',
      branch: 'feature/round-trip',
      simple: null,
      tdd: null,
      discovered_from: 101,
      issue:
        '["https://github.com/example/repo/issues/3","https://github.com/example/repo/issues/7"]',
      pull_request: '["https://github.com/example/repo/pull/31"]',
      assigned_to: 'qa-agent',
      base_branch: 'develop',
      temp: 0,
      docs: '["docs/primary.md","docs/round-trip.md"]',
      changed_files:
        '["src/tim/plan_materialize.ts","src/tim/plan_materialize.test.ts","src/tim/commands/materialize.ts"]',
      plan_generated_at: '2026-03-24T00:00:00.000Z',
      review_issues:
        '[{"severity":"critical","category":"correctness","content":"Round-trip coverage must preserve review findings","file":"src/tim/plan_materialize.ts","line":42},{"severity":"minor","category":"coverage","content":"Verify cleanup cases","file":"src/tim/plan_materialize.test.ts","line":1}]',
      parent_uuid: '11111111-1111-4111-8111-111111111111',
    });

    expect(
      getPlanTasksByUuid(db, '33333333-3333-4333-8333-333333333333').map((task) => ({
        task_index: task.task_index,
        title: task.title,
        description: task.description,
        done: task.done,
      }))
    ).toEqual([
      {
        task_index: 0,
        title: 'rewrite',
        description: 'exercise every field',
        done: 1,
      },
      {
        task_index: 1,
        title: 'verify',
        description: 'read back from DB and disk',
        done: 0,
      },
    ]);
    expect(
      getPlanDependenciesByUuid(db, '33333333-3333-4333-8333-333333333333').map(
        (dependency) => dependency.depends_on_uuid
      )
    ).toEqual(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
    expect(getPlanTagsByUuid(db, '33333333-3333-4333-8333-333333333333')).toEqual([
      { plan_uuid: '33333333-3333-4333-8333-333333333333', tag: 'materialize' },
      { plan_uuid: '33333333-3333-4333-8333-333333333333', tag: 'round-trip' },
      { plan_uuid: '33333333-3333-4333-8333-333333333333', tag: 'verified' },
    ]);

    const rematerializedPlan = await readPlanFile(planPath);
    expect(rematerializedPlan).toMatchObject({
      id: 3,
      uuid: '33333333-3333-4333-8333-333333333333',
      title: 'Primary plan round-tripped',
      goal: 'Updated primary goal',
      details: 'Updated primary details',
      status: 'done',
      priority: 'medium',
      branch: 'feature/round-trip',
      discoveredFrom: 101,
      issue: [
        'https://github.com/example/repo/issues/3',
        'https://github.com/example/repo/issues/7',
      ],
      pullRequest: ['https://github.com/example/repo/pull/31'],
      assignedTo: 'qa-agent',
      baseBranch: 'develop',
      temp: false,
      docs: ['docs/primary.md', 'docs/round-trip.md'],
      changedFiles: [
        'src/tim/plan_materialize.ts',
        'src/tim/plan_materialize.test.ts',
        'src/tim/commands/materialize.ts',
      ],
      planGeneratedAt: '2026-03-24T00:00:00.000Z',
      reviewIssues: [
        {
          severity: 'critical',
          category: 'correctness',
          content: 'Round-trip coverage must preserve review findings',
          file: 'src/tim/plan_materialize.ts',
          line: 42,
        },
        {
          severity: 'minor',
          category: 'coverage',
          content: 'Verify cleanup cases',
          file: 'src/tim/plan_materialize.test.ts',
          line: 1,
        },
      ],
      parent: 1,
      dependencies: [1, 2],
      tags: ['materialize', 'round-trip', 'verified'],
      materializedAs: 'primary',
    });
    expect(rematerializedPlan.simple).toBeUndefined();
    expect(rematerializedPlan.tdd).toBeUndefined();
    expect(rematerializedPlan.tasks).toEqual([
      { title: 'rewrite', description: 'exercise every field', done: true },
      { title: 'verify', description: 'read back from DB and disk', done: false },
    ]);
  });

  test('getPlanByPlanId rejects duplicate plan IDs within a project', async () => {
    const { db, project } = await seedProject();

    upsertPlan(db, project.id, {
      uuid: '66666666-6666-4666-8666-666666666666',
      planId: 3,
      title: 'Duplicate plan',
      filename: '3-duplicate.plan.md',
    });

    expect(() => getPlanByPlanId(db, project.id, 3)).toThrow(
      `Multiple plans found for project ${project.id} with plan ID 3`
    );
  });
});
