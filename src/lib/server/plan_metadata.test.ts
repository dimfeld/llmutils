import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { clearConfigCache } from '$tim/configLoader.js';
import { importAssignment } from '$tim/db/assignment.js';
import { closeDatabaseForTesting, getDatabase, openDatabase } from '$tim/db/database.js';
import {
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlanTagsByUuid,
  upsertPlanDependencies,
  upsertPlan,
} from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { materializePlan, resolveProjectContext } from '$tim/plan_materialize.js';
import { readPlanFile, writePlanFile } from '$tim/plans.js';
import { clearAllTimCaches } from '../../testing.js';
import {
  PlanMetadataValidationError,
  createPlanFromWeb,
  normalizePlanPriority,
  normalizePlanStatus,
  normalizeWebPlanMetadataInput,
  resolvePlanMetadataReferences,
  updatePlanMetadataFromWeb,
} from './plan_metadata.js';

describe('plan metadata validation helpers', () => {
  let db: Database;
  let tempDir: string;
  let projectRoot: string;
  let otherProjectRoot: string;
  let projectId: number;
  let otherProjectId: number;

  beforeEach(async () => {
    clearConfigCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-metadata-test-'));
    projectRoot = path.join(tempDir, 'repo');
    otherProjectRoot = path.join(tempDir, 'other-repo');
    await fs.mkdir(path.join(projectRoot, '.tim', 'config'), { recursive: true });
    await fs.mkdir(path.join(otherProjectRoot, '.tim', 'config'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.tim', 'config', 'tim.yml'),
      ['tags:', '  allowed:', '    - feature', '    - bug', ''].join('\n')
    );

    db = openDatabase(':memory:');
    projectId = getOrCreateProject(db, 'repo-plan-metadata', {
      lastGitRoot: projectRoot,
    }).id;
    otherProjectId = getOrCreateProject(db, 'repo-plan-metadata-other', {
      lastGitRoot: otherProjectRoot,
    }).id;

    seedPlan({ uuid: 'plan-current', planId: 1, title: 'Current plan' });
    seedPlan({ uuid: 'plan-parent', planId: 2, title: 'Parent plan' });
    seedPlan({ uuid: 'plan-base', planId: 3, title: 'Base plan' });
    seedPlan({ uuid: 'plan-dependency', planId: 4, title: 'Dependency plan' });
    seedPlan({
      uuid: 'plan-other-project',
      planId: 5,
      title: 'Other project plan',
      projectId: otherProjectId,
    });
  });

  afterEach(async () => {
    clearConfigCache();
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('normalizes writable metadata fields and resolves same-project references', async () => {
    const normalized = await normalizeWebPlanMetadataInput(
      db,
      projectId,
      {
        title: '  Add web metadata  ',
        goal: '  Make metadata editable  ',
        note: '  Keep internal context  ',
        details: '   ',
        priority: 'high',
        status: 'in_progress',
        simple: true,
        tags: [' Feature ', 'bug', 'feature'],
        parentUuid: 'plan-parent',
        basePlanUuid: 'plan-base',
        dependencyUuids: ['plan-dependency', 'plan-dependency'],
      },
      { currentPlanUuid: 'plan-current', requireTitle: true }
    );

    expect(normalized).toEqual({
      title: 'Add web metadata',
      goal: 'Make metadata editable',
      note: 'Keep internal context',
      details: null,
      priority: 'high',
      status: 'in_progress',
      simple: true,
      tags: ['bug', 'feature'],
      parentUuid: 'plan-parent',
      basePlanUuid: 'plan-base',
      dependencyUuids: ['plan-dependency'],
    });
  });

  test('rejects display-only and unknown statuses', () => {
    expect(() => normalizePlanStatus('ready')).toThrowMetadataError({
      kind: 'validation_failed',
      field: 'status',
    });
    expect(() => normalizePlanStatus('unknown')).toThrowMetadataError({
      kind: 'validation_failed',
      field: 'status',
    });
  });

  test('rejects invalid priorities', () => {
    expect(() => normalizePlanPriority('critical')).toThrowMetadataError({
      kind: 'validation_failed',
      field: 'priority',
    });
  });

  test('validates tags against the target project effective config', async () => {
    await expect(
      normalizeWebPlanMetadataInput(db, projectId, {
        title: 'Tagged plan',
        tags: ['feature', 'blocked'],
      })
    ).rejects.toMatchObject({
      kind: 'validation_failed',
      field: 'tags',
      message: expect.stringContaining('Invalid tag: blocked'),
    });
  });

  test('loads tag validation config from the target project git root', async () => {
    const normalized = await normalizeWebPlanMetadataInput(db, otherProjectId, {
      title: 'Other tagged plan',
      tags: ['Feature', 'blocked'],
    });

    expect(normalized.tags).toEqual(['blocked', 'feature']);
  });

  test('requires a title only when requested', async () => {
    await expect(
      normalizeWebPlanMetadataInput(db, projectId, {}, { requireTitle: true })
    ).rejects.toMatchObject({
      kind: 'validation_failed',
      field: 'title',
    });

    await expect(normalizeWebPlanMetadataInput(db, projectId, {})).resolves.toMatchObject({
      title: undefined,
    });
  });

  test('preserves explicit reference clearing through normalization', async () => {
    const normalized = await normalizeWebPlanMetadataInput(
      db,
      projectId,
      {
        parentUuid: null,
        basePlanUuid: null,
        dependencyUuids: [],
      },
      { currentPlanUuid: 'plan-current' }
    );

    expect(normalized).toMatchObject({
      parentUuid: null,
      basePlanUuid: null,
      dependencyUuids: [],
    });
  });

  test('rejects missing references', () => {
    expect(() =>
      resolvePlanMetadataReferences(db, projectId, {
        parentUuid: 'missing-plan',
      })
    ).toThrowMetadataError({
      kind: 'invalid_reference',
      field: 'parentUuid',
    });
  });

  test('rejects references from another project', () => {
    expect(() =>
      resolvePlanMetadataReferences(db, projectId, {
        basePlanUuid: 'plan-other-project',
      })
    ).toThrowMetadataError({
      kind: 'project_mismatch',
      field: 'basePlanUuid',
    });
  });

  test('rejects self references for parent, base plan, and dependencies', () => {
    expect(() =>
      resolvePlanMetadataReferences(
        db,
        projectId,
        {
          parentUuid: 'plan-current',
        },
        { currentPlanUuid: 'plan-current' }
      )
    ).toThrowMetadataError({
      kind: 'invalid_reference',
      field: 'parentUuid',
    });

    expect(() =>
      resolvePlanMetadataReferences(
        db,
        projectId,
        {
          basePlanUuid: 'plan-current',
        },
        { currentPlanUuid: 'plan-current' }
      )
    ).toThrowMetadataError({
      kind: 'invalid_reference',
      field: 'basePlanUuid',
    });

    expect(() =>
      resolvePlanMetadataReferences(
        db,
        projectId,
        {
          dependencyUuids: ['plan-current'],
        },
        { currentPlanUuid: 'plan-current' }
      )
    ).toThrowMetadataError({
      kind: 'invalid_reference',
      field: 'dependencyUuids',
    });
  });

  function seedPlan(options: {
    uuid: string;
    planId: number;
    title: string;
    projectId?: number;
  }): void {
    upsertPlan(db, options.projectId ?? projectId, {
      uuid: options.uuid,
      planId: options.planId,
      title: options.title,
      status: 'pending',
      priority: 'medium',
    });
  }
});

describe('createPlanFromWeb', () => {
  let db: Database;
  let tempDir: string;
  let projectRoot: string;
  let otherProjectRoot: string;
  let projectId: number;
  let otherProjectId: number;

  const parentUuid = '11111111-1111-4111-8111-111111111111';
  const basePlanUuid = '22222222-2222-4222-8222-222222222222';
  const dependencyUuid = '33333333-3333-4333-8333-333333333333';
  const otherProjectPlanUuid = '44444444-4444-4444-8444-444444444444';

  beforeEach(async () => {
    clearConfigCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-metadata-create-test-'));
    projectRoot = path.join(tempDir, 'repo');
    otherProjectRoot = path.join(tempDir, 'other-repo');
    await fs.mkdir(path.join(projectRoot, '.tim', 'config'), { recursive: true });
    await fs.mkdir(path.join(otherProjectRoot, '.tim', 'config'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.tim', 'config', 'tim.yml'),
      ['tags:', '  allowed:', '    - feature', '    - bug', ''].join('\n')
    );

    db = openDatabase(':memory:');
    projectId = getOrCreateProject(db, 'repo-plan-metadata-create', {
      lastGitRoot: projectRoot,
    }).id;
    otherProjectId = getOrCreateProject(db, 'repo-plan-metadata-create-other', {
      lastGitRoot: otherProjectRoot,
    }).id;

    seedPlan({ uuid: parentUuid, planId: 7, title: 'Parent plan' });
    seedPlan({ uuid: basePlanUuid, planId: 8, title: 'Base plan' });
    seedPlan({ uuid: dependencyUuid, planId: 9, title: 'Dependency plan' });
    seedPlan({
      uuid: otherProjectPlanUuid,
      planId: 1,
      title: 'Other project plan',
      projectId: otherProjectId,
    });
  });

  afterEach(async () => {
    clearConfigCache();
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('creates a simple plan through the sync write path', async () => {
    const result = await createPlanFromWeb(db, {
      projectId,
      title: '  Web-created plan  ',
    });

    expect(result).toMatchObject({ projectId, planId: 10 });
    const plan = getPlanByUuid(db, result.planUuid);
    expect(plan).toMatchObject({
      project_id: projectId,
      plan_id: 10,
      title: 'Web-created plan',
      status: 'pending',
      priority: 'medium',
      simple: 0,
    });
    expect(syncOperationRows()).toEqual([{ operation_type: 'plan.create', status: 'applied' }]);
  });

  test('creates a plan with relationships, tags, simple flag, status, and priority', async () => {
    const result = await createPlanFromWeb(db, {
      projectId,
      title: 'Relationship plan',
      goal: '  Connect plans  ',
      details: '  Detailed markdown  ',
      priority: 'high',
      status: 'in_progress',
      simple: true,
      tags: [' Feature ', 'bug', 'feature'],
      parentUuid,
      basePlanUuid,
      dependencyUuids: [dependencyUuid, dependencyUuid],
    });

    const plan = getPlanByUuid(db, result.planUuid);
    expect(plan).toMatchObject({
      title: 'Relationship plan',
      goal: 'Connect plans',
      details: 'Detailed markdown',
      priority: 'high',
      status: 'in_progress',
      simple: 1,
      parent_uuid: parentUuid,
      base_plan_uuid: basePlanUuid,
    });
    expect(getPlanTagsByUuid(db, result.planUuid).map((tag) => tag.tag)).toEqual([
      'bug',
      'feature',
    ]);
    expect(
      getPlanDependenciesByUuid(db, result.planUuid).map((dependency) => dependency.depends_on_uuid)
    ).toEqual([dependencyUuid]);
  });

  test('updates the parent dependency graph through operation folding', async () => {
    const result = await createPlanFromWeb(db, {
      projectId,
      title: 'Child plan',
      parentUuid,
    });

    expect(
      getPlanDependenciesByUuid(db, parentUuid).map((dependency) => dependency.depends_on_uuid)
    ).toContain(result.planUuid);
  });

  test('rejects all-project creation', async () => {
    await expect(
      createPlanFromWeb(db, {
        projectId: 'all',
        title: 'Cannot create here',
      })
    ).rejects.toMatchObject({
      kind: 'validation_failed',
      field: 'projectId',
    });
  });

  test('rejects invalid references before writing', async () => {
    await expect(
      createPlanFromWeb(db, {
        projectId,
        title: 'Bad reference',
        dependencyUuids: [otherProjectPlanUuid],
      })
    ).rejects.toMatchObject({
      kind: 'project_mismatch',
      field: 'dependencyUuids',
    });
    expect(syncOperationRows()).toEqual([]);
  });

  test('rejects missing parent, base plan, and dependency references before writing', async () => {
    await expect(
      createPlanFromWeb(db, {
        projectId,
        title: 'Missing parent',
        parentUuid: '55555555-5555-4555-8555-555555555555',
      })
    ).rejects.toMatchObject({
      kind: 'invalid_reference',
      field: 'parentUuid',
    });

    await expect(
      createPlanFromWeb(db, {
        projectId,
        title: 'Missing base',
        basePlanUuid: '66666666-6666-4666-8666-666666666666',
      })
    ).rejects.toMatchObject({
      kind: 'invalid_reference',
      field: 'basePlanUuid',
    });

    await expect(
      createPlanFromWeb(db, {
        projectId,
        title: 'Missing dependency',
        dependencyUuids: ['77777777-7777-4777-8777-777777777777'],
      })
    ).rejects.toMatchObject({
      kind: 'invalid_reference',
      field: 'dependencyUuids',
    });

    expect(syncOperationRows()).toEqual([]);
  });

  test('rejects invalid tags using project-effective config', async () => {
    await expect(
      createPlanFromWeb(db, {
        projectId,
        title: 'Bad tag',
        tags: ['blocked'],
      })
    ).rejects.toMatchObject({
      kind: 'validation_failed',
      field: 'tags',
    });
  });

  test('rejects invalid status', async () => {
    await expect(
      createPlanFromWeb(db, {
        projectId,
        title: 'Bad status',
        status: 'ready',
      })
    ).rejects.toMatchObject({
      kind: 'validation_failed',
      field: 'status',
    });
    expect(syncOperationRows()).toEqual([]);
  });

  test('rejects invalid priority before writing', async () => {
    await expect(
      createPlanFromWeb(db, {
        projectId,
        title: 'Bad priority',
        priority: 'critical',
      })
    ).rejects.toMatchObject({
      kind: 'validation_failed',
      field: 'priority',
    });
    expect(syncOperationRows()).toEqual([]);
  });

  function seedPlan(options: {
    uuid: string;
    planId: number;
    title: string;
    projectId?: number;
  }): void {
    upsertPlan(db, options.projectId ?? projectId, {
      uuid: options.uuid,
      planId: options.planId,
      title: options.title,
      status: 'pending',
      priority: 'medium',
    });
  }

  function syncOperationRows(): Array<{ operation_type: string; status: string }> {
    return db
      .query<{ operation_type: string; status: string }, []>(
        'SELECT operation_type, status FROM sync_operation ORDER BY local_sequence'
      )
      .all();
  }
});

describe('updatePlanMetadataFromWeb', () => {
  let db: Database;
  let tempDir: string;
  let projectRoot: string;
  let otherProjectRoot: string;
  let projectId: number;
  let otherProjectId: number;

  const planUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const oldParentUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const newParentUuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const basePlanUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const oldDependencyUuid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const newDependencyUuid = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const cycleDependencyUuid = '11111111-2222-4333-8444-555555555555';
  const otherProjectPlanUuid = '99999999-9999-4999-8999-999999999999';

  beforeEach(async () => {
    clearConfigCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-metadata-update-test-'));
    projectRoot = path.join(tempDir, 'repo');
    otherProjectRoot = path.join(tempDir, 'other-repo');
    await fs.mkdir(path.join(projectRoot, '.tim', 'config'), { recursive: true });
    await fs.mkdir(path.join(otherProjectRoot, '.tim', 'config'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.tim', 'config', 'tim.yml'),
      ['tags:', '  allowed:', '    - feature', '    - bug', '    - backend', ''].join('\n')
    );

    db = openDatabase(':memory:');
    projectId = getOrCreateProject(db, 'repo-plan-metadata-update', {
      lastGitRoot: projectRoot,
    }).id;
    otherProjectId = getOrCreateProject(db, 'repo-plan-metadata-update-other', {
      lastGitRoot: otherProjectRoot,
    }).id;

    seedPlan({ uuid: oldParentUuid, planId: 1, title: 'Old parent' });
    seedPlan({ uuid: newParentUuid, planId: 2, title: 'New parent' });
    seedPlan({ uuid: basePlanUuid, planId: 3, title: 'Base plan' });
    seedPlan({ uuid: oldDependencyUuid, planId: 4, title: 'Old dependency' });
    seedPlan({ uuid: newDependencyUuid, planId: 5, title: 'New dependency' });
    seedPlan({
      uuid: planUuid,
      planId: 6,
      title: 'Original title',
      goal: 'Original goal',
      note: 'Original note',
      details: 'Original details',
      priority: 'medium',
      status: 'pending',
      simple: false,
      parentUuid: oldParentUuid,
      dependencyUuids: [oldDependencyUuid],
      tags: ['feature'],
    });
    upsertPlanDependencies(db, oldParentUuid, [planUuid]);
    seedPlan({
      uuid: cycleDependencyUuid,
      planId: 7,
      title: 'Cycle dependency',
      dependencyUuids: [planUuid],
    });
    seedPlan({
      uuid: otherProjectPlanUuid,
      planId: 1,
      title: 'Other project plan',
      projectId: otherProjectId,
    });
  });

  afterEach(async () => {
    clearConfigCache();
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('updates writable metadata fields through one sync batch', async () => {
    const result = await updatePlanMetadataFromWeb(db, {
      projectId,
      planUuid,
      title: '  Updated title  ',
      goal: '  Updated goal  ',
      note: '  Updated note  ',
      details: '  Updated details  ',
      priority: 'high',
      status: 'in_progress',
      simple: true,
      tags: [' Backend ', 'bug', 'backend'],
      basePlanUuid,
      dependencyUuids: [newDependencyUuid, newDependencyUuid],
    });

    expect(result).toEqual({ planUuid });
    expect(getPlanByUuid(db, planUuid)).toMatchObject({
      title: 'Updated title',
      goal: 'Updated goal',
      note: 'Updated note',
      details: 'Updated details',
      priority: 'high',
      status: 'in_progress',
      simple: 1,
      base_plan_uuid: basePlanUuid,
    });
    expect(getPlanTagsByUuid(db, planUuid).map((tag) => tag.tag)).toEqual(['backend', 'bug']);
    expect(
      getPlanDependenciesByUuid(db, planUuid).map((dependency) => dependency.depends_on_uuid)
    ).toEqual([newDependencyUuid]);
    expect(syncOperationRows().map((row) => row.operation_type)).toEqual([
      'plan.patch_text',
      'plan.patch_text',
      'plan.patch_text',
      'plan.patch_text',
      'plan.set_scalar',
      'plan.set_scalar',
      'plan.set_scalar',
      'plan.set_scalar',
      'plan.add_dependency',
      'plan.remove_dependency',
      'plan.add_tag',
      'plan.add_tag',
      'plan.remove_tag',
    ]);
  });

  test('allows all-project route updates but rejects mismatched concrete route projects', async () => {
    await expect(
      updatePlanMetadataFromWeb(db, {
        projectId: 'all',
        planUuid,
        title: 'All route update',
      })
    ).resolves.toEqual({ planUuid });

    await expect(
      updatePlanMetadataFromWeb(db, {
        projectId: otherProjectId,
        planUuid,
        title: 'Wrong route project',
      })
    ).rejects.toMatchObject({
      kind: 'project_mismatch',
      field: 'projectId',
    });
  });

  test('updates old and new parent dependency edges', async () => {
    await updatePlanMetadataFromWeb(db, {
      projectId,
      planUuid,
      parentUuid: newParentUuid,
    });

    expect(
      getPlanDependenciesByUuid(db, oldParentUuid).map((dependency) => dependency.depends_on_uuid)
    ).not.toContain(planUuid);
    expect(
      getPlanDependenciesByUuid(db, newParentUuid).map((dependency) => dependency.depends_on_uuid)
    ).toContain(planUuid);
    expect(getPlanByUuid(db, planUuid)?.parent_uuid).toBe(newParentUuid);
  });

  test('clears parent, base plan, and tags through update diffs', async () => {
    await updatePlanMetadataFromWeb(db, {
      projectId,
      planUuid,
      basePlanUuid,
    });

    await updatePlanMetadataFromWeb(db, {
      projectId,
      planUuid,
      parentUuid: null,
      basePlanUuid: null,
      tags: [],
    });

    expect(getPlanByUuid(db, planUuid)).toMatchObject({
      parent_uuid: null,
      base_plan_uuid: null,
    });
    expect(
      getPlanDependenciesByUuid(db, oldParentUuid).map((dependency) => dependency.depends_on_uuid)
    ).not.toContain(planUuid);
    expect(getPlanTagsByUuid(db, planUuid)).toEqual([]);
  });

  test('treats null simple input as unset for updates', async () => {
    await updatePlanMetadataFromWeb(db, {
      projectId,
      planUuid,
      simple: null,
    });

    expect(getPlanByUuid(db, planUuid)?.simple).toBe(0);
    expect(syncOperationRows()).toEqual([]);
  });

  test('rejects invalid mixed updates atomically', async () => {
    await expect(
      updatePlanMetadataFromWeb(db, {
        projectId,
        planUuid,
        title: 'Should roll back',
        dependencyUuids: [cycleDependencyUuid],
      })
    ).rejects.toThrow(/cycle/i);

    expect(getPlanByUuid(db, planUuid)?.title).toBe('Original title');
    expect(
      getPlanDependenciesByUuid(db, planUuid).map((dependency) => dependency.depends_on_uuid)
    ).toEqual([oldDependencyUuid]);
    expect(syncOperationRows()).toEqual([
      { operation_type: 'plan.patch_text', status: 'rejected' },
      { operation_type: 'plan.add_dependency', status: 'rejected' },
      { operation_type: 'plan.remove_dependency', status: 'rejected' },
    ]);
  });

  test('rejects invalid references before writing', async () => {
    await expect(
      updatePlanMetadataFromWeb(db, {
        projectId,
        planUuid,
        basePlanUuid: otherProjectPlanUuid,
      })
    ).rejects.toMatchObject({
      kind: 'project_mismatch',
      field: 'basePlanUuid',
    });
  });

  test('cleans up assignments for terminal and review status updates', async () => {
    importAssignment(
      db,
      projectId,
      planUuid,
      6,
      null,
      'dimfeld',
      'in_progress',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );

    await updatePlanMetadataFromWeb(db, {
      projectId,
      planUuid,
      status: 'needs_review',
    });

    expect(assignmentCount(planUuid)).toBe(0);
  });

  test('runs parent completion cascade after status updates', async () => {
    const cascadeParentUuid = '12121212-1212-4121-8121-121212121212';
    const cascadeChildUuid = '34343434-3434-4343-8343-343434343434';
    seedPlan({
      uuid: cascadeParentUuid,
      planId: 20,
      title: 'Cascade parent',
      status: 'pending',
      epic: true,
    });
    seedPlan({
      uuid: cascadeChildUuid,
      planId: 21,
      title: 'Cascade child',
      status: 'pending',
      parentUuid: cascadeParentUuid,
    });
    upsertPlanDependencies(db, cascadeParentUuid, [cascadeChildUuid]);

    await updatePlanMetadataFromWeb(db, {
      projectId,
      planUuid: cascadeChildUuid,
      status: 'done',
    });

    expect(getPlanByUuid(db, cascadeChildUuid)?.status).toBe('done');
    expect(getPlanByUuid(db, cascadeParentUuid)?.status).toBe('needs_review');
  });

  function seedPlan(options: {
    uuid: string;
    planId: number;
    title: string;
    projectId?: number;
    goal?: string;
    details?: string;
    priority?: 'low' | 'medium' | 'high' | 'urgent' | 'maybe' | null;
    status?:
      | 'pending'
      | 'in_progress'
      | 'needs_review'
      | 'reviewed'
      | 'done'
      | 'cancelled'
      | 'deferred';
    simple?: boolean;
    parentUuid?: string | null;
    basePlanUuid?: string | null;
    epic?: boolean;
    dependencyUuids?: string[];
    tags?: string[];
  }): void {
    upsertPlan(db, options.projectId ?? projectId, {
      uuid: options.uuid,
      planId: options.planId,
      title: options.title,
      goal: options.goal,
      details: options.details,
      status: options.status ?? 'pending',
      priority: options.priority ?? 'medium',
      simple: options.simple,
      parentUuid: options.parentUuid,
      basePlanUuid: options.basePlanUuid,
      epic: options.epic,
      dependencyUuids: options.dependencyUuids,
      tags: options.tags,
    });
  }

  function assignmentCount(uuid: string): number {
    const row = db
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) AS count FROM assignment WHERE plan_uuid = ?'
      )
      .get(uuid);
    return row?.count ?? 0;
  }

  function syncOperationRows(): Array<{ operation_type: string; status: string }> {
    return db
      .query<{ operation_type: string; status: string }, []>(
        'SELECT operation_type, status FROM sync_operation ORDER BY local_sequence'
      )
      .all();
  }
});

describe('plan metadata materialized file consistency', () => {
  let db: Database;
  let tempDir: string;
  let projectRoot: string;
  let projectId: number;
  let originalXdgConfigHome: string | undefined;
  let originalGitConfigGlobal: string | undefined;

  const planUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const oldParentUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const newParentUuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const childUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-metadata-materialized-test-'));
    projectRoot = path.join(tempDir, 'repo');
    await fs.mkdir(path.join(projectRoot, '.tim', 'config'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.tim', 'config', 'tim.yml'), 'paths:\n  tasks: .\n');
    await initializeGitRepository(projectRoot);

    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg');
    originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = path.join(tempDir, 'gitconfig-global');
    await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, '', 'utf8');

    db = getDatabase();
    projectId = (await resolveProjectContext(projectRoot)).projectId;
  });

  afterEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();

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

  test('syncs existing materialized plan edits before applying web metadata updates', async () => {
    seedPlan({
      uuid: planUuid,
      planId: 1,
      title: 'Original title',
      goal: 'Original goal',
      details: 'Original details',
    });

    const planPath = await materializePlan(1, projectRoot);
    const materializedPlan = await readPlanFile(planPath);
    materializedPlan.goal = 'Goal edited in materialized file';
    await writePlanFile(planPath, materializedPlan, { skipDb: true });

    await updatePlanMetadataFromWeb(db, {
      projectId,
      planUuid,
      title: 'Web title',
    });

    expect(getPlanByUuid(db, planUuid)).toMatchObject({
      title: 'Web title',
      goal: 'Goal edited in materialized file',
    });

    const refreshedPlan = await readPlanFile(planPath);
    expect(refreshedPlan.title).toBe('Web title');
    expect(refreshedPlan.goal).toBe('Goal edited in materialized file');
  });

  test('syncs and rematerializes materialized parents when changing parent relationship', async () => {
    seedPlan({ uuid: oldParentUuid, planId: 1, title: 'Old parent', details: 'Old details' });
    seedPlan({ uuid: newParentUuid, planId: 2, title: 'New parent', details: 'New details' });
    seedPlan({
      uuid: childUuid,
      planId: 3,
      title: 'Child plan',
      details: 'Child details',
      parentUuid: oldParentUuid,
    });
    upsertPlanDependencies(db, oldParentUuid, [childUuid]);

    const oldParentPath = await materializePlan(1, projectRoot);
    const newParentPath = await materializePlan(2, projectRoot);
    const childPath = await materializePlan(3, projectRoot);

    const oldParent = await readPlanFile(oldParentPath);
    oldParent.details = 'Old parent local materialized edit';
    await writePlanFile(oldParentPath, oldParent, { skipDb: true });

    const newParent = await readPlanFile(newParentPath);
    newParent.details = 'New parent local materialized edit';
    await writePlanFile(newParentPath, newParent, { skipDb: true });

    const child = await readPlanFile(childPath);
    child.goal = 'Child local materialized edit';
    await writePlanFile(childPath, child, { skipDb: true });

    await updatePlanMetadataFromWeb(db, {
      projectId,
      planUuid: childUuid,
      parentUuid: newParentUuid,
    });

    const refreshedOldParent = await readPlanFile(oldParentPath);
    const refreshedNewParent = await readPlanFile(newParentPath);
    const refreshedChild = await readPlanFile(childPath);

    expect(refreshedOldParent.details).toBe('Old parent local materialized edit');
    expect(refreshedOldParent.dependencies ?? []).not.toContain(3);
    expect(refreshedNewParent.details).toBe('New parent local materialized edit');
    expect(refreshedNewParent.dependencies ?? []).toContain(3);
    expect(refreshedChild.goal).toBe('Child local materialized edit');
    expect(refreshedChild.parent).toBe(2);
  });

  test('syncs and rematerializes an existing materialized parent during web plan creation', async () => {
    seedPlan({ uuid: oldParentUuid, planId: 1, title: 'Parent plan', details: 'Parent details' });

    const parentPath = await materializePlan(1, projectRoot);
    const parent = await readPlanFile(parentPath);
    parent.details = 'Parent local materialized edit before create';
    await writePlanFile(parentPath, parent, { skipDb: true });

    const result = await createPlanFromWeb(db, {
      projectId,
      title: 'Created child',
      parentUuid: oldParentUuid,
    });

    const refreshedParent = await readPlanFile(parentPath);
    expect(refreshedParent.details).toBe('Parent local materialized edit before create');
    expect(refreshedParent.dependencies ?? []).toContain(result.planId);
  });

  test('rematerializes parent plans touched by status completion cascades', async () => {
    seedPlan({
      uuid: oldParentUuid,
      planId: 1,
      title: 'Cascade parent',
      details: 'Parent details',
      epic: true,
    });
    seedPlan({
      uuid: childUuid,
      planId: 2,
      title: 'Cascade child',
      details: 'Child details',
      parentUuid: oldParentUuid,
    });
    upsertPlanDependencies(db, oldParentUuid, [childUuid]);

    const parentPath = await materializePlan(1, projectRoot);
    const parent = await readPlanFile(parentPath);
    parent.details = 'Parent local materialized edit before cascade';
    await writePlanFile(parentPath, parent, { skipDb: true });

    await updatePlanMetadataFromWeb(db, {
      projectId,
      planUuid: childUuid,
      status: 'done',
    });

    const refreshedParent = await readPlanFile(parentPath);
    expect(refreshedParent.details).toBe('Parent local materialized edit before cascade');
    expect(refreshedParent.status).toBe('needs_review');
  });

  function seedPlan(options: {
    uuid: string;
    planId: number;
    title: string;
    goal?: string;
    details?: string;
    parentUuid?: string | null;
    epic?: boolean;
  }): void {
    upsertPlan(db, projectId, {
      uuid: options.uuid,
      planId: options.planId,
      title: options.title,
      goal: options.goal,
      details: options.details,
      status: 'pending',
      priority: 'medium',
      parentUuid: options.parentUuid,
      epic: options.epic,
    });
  }
});

async function initializeGitRepository(repoDir: string): Promise<void> {
  await Bun.$`git init`.cwd(repoDir).quiet();
  await Bun.$`git remote add origin https://example.com/acme/plan-metadata-materialized.git`
    .cwd(repoDir)
    .quiet();
}

expect.extend({
  toThrowMetadataError(
    received: () => unknown,
    expected: { kind: string; field: string }
  ): { pass: boolean; message: () => string } {
    try {
      received();
    } catch (error) {
      const pass =
        error instanceof PlanMetadataValidationError &&
        error.kind === expected.kind &&
        error.field === expected.field;
      return {
        pass,
        message: () =>
          `expected metadata error ${expected.kind}/${expected.field}, received ${
            error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          }`,
      };
    }

    return {
      pass: false,
      message: () =>
        `expected metadata error ${expected.kind}/${expected.field}, received no error`,
    };
  },
});

declare module 'vitest' {
  interface Assertion<T = unknown> {
    toThrowMetadataError(expected: { kind: string; field: string }): T;
  }
}
