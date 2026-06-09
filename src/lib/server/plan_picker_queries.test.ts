import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openDatabase } from '$tim/db/database.js';
import { nonSyncedUpsertPlan } from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { searchPlanPickerOptions } from './plan_picker_queries.js';

describe('searchPlanPickerOptions', () => {
  let db: Database;
  let projectId: number;
  let otherProjectId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    projectId = getOrCreateProject(db, 'repo-picker').id;
    otherProjectId = getOrCreateProject(db, 'repo-picker-other').id;

    seedPlan({ uuid: 'plan-current', planId: 10, title: 'Current web metadata plan' });
    seedPlan({ uuid: 'plan-alpha', planId: 11, title: 'Alpha relationship target' });
    seedPlan({ uuid: 'plan-beta', planId: 12, title: 'Beta relationship target' });
    seedPlan({
      uuid: 'plan-descendant',
      planId: 13,
      title: 'Descendant relationship target',
      parentUuid: 'plan-current',
    });
    seedPlan({
      uuid: 'plan-grandchild',
      planId: 16,
      title: 'Grandchild relationship target',
      parentUuid: 'plan-descendant',
    });
    seedPlan({
      uuid: 'plan-cycle-dependency',
      planId: 14,
      title: 'Cycle dependency target',
      dependencyUuids: ['plan-current'],
    });
    seedPlan({
      uuid: 'plan-transitive-cycle-dependency',
      planId: 17,
      title: 'Transitive cycle dependency target',
      dependencyUuids: ['plan-cycle-dependency'],
    });
    seedPlan({
      uuid: 'plan-parent-dependency',
      planId: 15,
      title: 'Parent dependency target',
    });
    seedPlan({
      uuid: 'plan-literal-percent',
      planId: 18,
      title: 'Literal 100% title marker',
    });
    seedPlan({
      uuid: 'plan-other-project',
      planId: 11,
      title: 'Alpha relationship target in another project',
      projectId: otherProjectId,
    });

    db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
      'plan-current',
      'plan-parent-dependency'
    );
  });

  afterEach(() => {
    db.close(false);
  });

  test('searches by exact numeric plan ID before title matches', () => {
    const result = searchPlanPickerOptions(db, {
      projectId,
      query: '11',
      relation: 'basePlan',
      limit: 10,
    });

    expect(result.map((option) => option.uuid)).toEqual(['plan-alpha']);
    expect(result[0]).toMatchObject({
      projectId,
      planId: 11,
      title: 'Alpha relationship target',
    });
  });

  test('searches by title and scopes results to one project', () => {
    const result = searchPlanPickerOptions(db, {
      projectId,
      query: 'relationship target',
      relation: 'basePlan',
      limit: 10,
    });

    expect(result.map((option) => option.uuid)).toContain('plan-alpha');
    expect(result.map((option) => option.uuid)).not.toContain('plan-other-project');
    expect(result.every((option) => option.projectId === projectId)).toBe(true);
  });

  test('escapes SQL wildcard characters in title searches', () => {
    const percentResult = searchPlanPickerOptions(db, {
      projectId,
      query: '%',
      relation: 'basePlan',
      limit: 10,
    });

    expect(percentResult.map((option) => option.uuid)).toEqual(['plan-literal-percent']);

    const underscoreResult = searchPlanPickerOptions(db, {
      projectId,
      query: '_',
      relation: 'basePlan',
      limit: 10,
    });

    expect(underscoreResult).toEqual([]);
  });

  test('returns no results for an empty query', () => {
    expect(
      searchPlanPickerOptions(db, {
        projectId,
        query: '   ',
        relation: 'dependency',
      })
    ).toEqual([]);
  });

  test('honors the requested limit', () => {
    const result = searchPlanPickerOptions(db, {
      projectId,
      query: 'target',
      relation: 'basePlan',
      limit: 2,
    });

    expect(result).toHaveLength(2);
  });

  test('continues scanning when early candidates are filtered as ineligible', () => {
    for (let index = 0; index < 120; index += 1) {
      seedPlan({
        uuid: `plan-windowed-descendant-${index}`,
        planId: 100 + index,
        title: 'Windowed relationship target',
        parentUuid: 'plan-current',
      });
    }
    seedPlan({
      uuid: 'plan-windowed-eligible',
      planId: 90,
      title: 'Windowed relationship target',
    });

    const result = searchPlanPickerOptions(db, {
      projectId,
      query: 'Windowed relationship target',
      relation: 'parent',
      currentPlanUuid: 'plan-current',
      limit: 1,
    });

    expect(result.map((option) => option.uuid)).toEqual(['plan-windowed-eligible']);
  });

  test('excludes the current plan for edit pickers', () => {
    const result = searchPlanPickerOptions(db, {
      projectId,
      query: 'Current',
      relation: 'basePlan',
      currentPlanUuid: 'plan-current',
    });

    expect(result).toEqual([]);
  });

  test('filters dependency options that would create a dependency cycle', () => {
    const result = searchPlanPickerOptions(db, {
      projectId,
      query: 'target',
      relation: 'dependency',
      currentPlanUuid: 'plan-current',
      limit: 10,
    });

    expect(result.map((option) => option.uuid)).toContain('plan-alpha');
    expect(result.map((option) => option.uuid)).not.toContain('plan-cycle-dependency');
    expect(result.map((option) => option.uuid)).not.toContain('plan-transitive-cycle-dependency');
  });

  test('filters parent options that are descendants or dependency-inconsistent', () => {
    const result = searchPlanPickerOptions(db, {
      projectId,
      query: 'target',
      relation: 'parent',
      currentPlanUuid: 'plan-current',
      limit: 10,
    });

    const uuids = result.map((option) => option.uuid);
    expect(uuids).toContain('plan-alpha');
    expect(uuids).not.toContain('plan-descendant');
    expect(uuids).not.toContain('plan-grandchild');
    expect(uuids).not.toContain('plan-parent-dependency');
  });

  test('base-plan options only apply same-project and current-plan exclusions', () => {
    const result = searchPlanPickerOptions(db, {
      projectId,
      query: 'target',
      relation: 'basePlan',
      currentPlanUuid: 'plan-current',
      limit: 10,
    });

    const uuids = result.map((option) => option.uuid);
    expect(uuids).toContain('plan-cycle-dependency');
    expect(uuids).toContain('plan-descendant');
    expect(uuids).not.toContain('plan-current');
    expect(uuids).not.toContain('plan-other-project');
  });

  test('rejects current-plan context from another project', () => {
    expect(() =>
      searchPlanPickerOptions(db, {
        projectId,
        query: 'target',
        relation: 'dependency',
        currentPlanUuid: 'plan-other-project',
      })
    ).toThrow(/Current plan not found in project/);
  });

  test('rejects unknown projects', () => {
    expect(() =>
      searchPlanPickerOptions(db, {
        projectId: 999_999,
        query: 'target',
        relation: 'basePlan',
      })
    ).toThrow(/Project not found/);
  });

  function seedPlan(options: {
    uuid: string;
    planId: number;
    title: string;
    projectId?: number;
    parentUuid?: string;
    dependencyUuids?: string[];
  }): void {
    nonSyncedUpsertPlan(db, options.projectId ?? projectId, {
      uuid: options.uuid,
      planId: options.planId,
      title: options.title,
      status: 'pending',
      priority: 'medium',
      parentUuid: options.parentUuid,
      dependencyUuids: options.dependencyUuids,
    });
  }
});
