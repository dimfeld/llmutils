import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import {
  applyInvalidationsWithSnapshots,
  orderCanonicalSnapshotsForMerge,
} from './result_application.js';
import type { CanonicalPlanSnapshot, CanonicalSnapshot } from './snapshots.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const OWNER_UUID = '10000000-0000-4000-8000-000000000000';
const DEPENDENCY_UUID = 'c0000000-0000-4000-8000-000000000000';
const BASE_UUID = 'd0000000-0000-4000-8000-000000000000';
const PARENT_UUID = 'e0000000-0000-4000-8000-000000000000';
const DISCOVERED_FROM_UUID = 'f0000000-0000-4000-8000-000000000000';

describe('canonical snapshot result application', () => {
  test('applies projects and referenced plans before owner snapshots', async () => {
    const db = createTestDb();
    const projectSnapshot: CanonicalSnapshot = {
      type: 'project',
      project: {
        uuid: PROJECT_UUID,
        repositoryId: 'github.com__example__repo',
        remoteUrl: 'https://github.com/example/repo.git',
        remoteLabel: 'origin',
        highestPlanId: 100,
      },
    };
    const settingSnapshot: CanonicalSnapshot = {
      type: 'project_setting',
      projectUuid: PROJECT_UUID,
      setting: 'review.model',
      value: 'gpt-test',
      revision: 1,
    };
    const ownerSnapshot = planSnapshot(OWNER_UUID, 1, {
      discoveredFrom: DISCOVERED_FROM_UUID,
      parentUuid: PARENT_UUID,
      basePlanUuid: BASE_UUID,
      dependencyUuids: [DEPENDENCY_UUID],
    });
    const fetchedSnapshots: CanonicalSnapshot[] = [
      settingSnapshot,
      ownerSnapshot,
      planSnapshot(DISCOVERED_FROM_UUID, 91),
      planSnapshot(PARENT_UUID, 92),
      planSnapshot(BASE_UUID, 93),
      planSnapshot(DEPENDENCY_UUID, 94),
      projectSnapshot,
    ];

    await applyInvalidationsWithSnapshots({
      db,
      invalidations: [
        {
          sequenceId: 1,
          entityKeys: fetchedSnapshots.map(snapshotEntityKey),
        },
      ],
      fetchSnapshots: async (): Promise<CanonicalSnapshot[]> => fetchedSnapshots,
    });

    const owner = db
      .prepare(
        `
          SELECT discovered_from, parent_uuid, base_plan_uuid
          FROM plan_canonical
          WHERE uuid = ?
        `
      )
      .get(OWNER_UUID) as {
      discovered_from: number | null;
      parent_uuid: string | null;
      base_plan_uuid: string | null;
    } | null;
    expect(owner).toEqual({
      discovered_from: 91,
      parent_uuid: PARENT_UUID,
      base_plan_uuid: BASE_UUID,
    });
    expect(
      db
        .prepare('SELECT depends_on_uuid FROM plan_dependency_canonical WHERE plan_uuid = ?')
        .all(OWNER_UUID)
    ).toEqual([{ depends_on_uuid: DEPENDENCY_UUID }]);
    expect(
      db
        .prepare(
          `
            SELECT psc.value
            FROM project_setting_canonical psc
            JOIN project p ON p.id = psc.project_id
            WHERE p.uuid = ? AND psc.setting = ?
          `
        )
        .get(PROJECT_UUID, 'review.model')
    ).toEqual({ value: '"gpt-test"' });
  });

  test('breaks plan-reference cycles deterministically and applies project deletions last', () => {
    const firstUuid = '20000000-0000-4000-8000-000000000000';
    const secondUuid = '30000000-0000-4000-8000-000000000000';
    const first = planSnapshot(firstUuid, 1, { parentUuid: secondUuid });
    const second = planSnapshot(secondUuid, 2, { parentUuid: firstUuid });
    const project: CanonicalSnapshot = {
      type: 'project',
      project: {
        uuid: PROJECT_UUID,
        repositoryId: 'github.com__example__repo',
        remoteUrl: null,
        remoteLabel: null,
        highestPlanId: 2,
      },
    };
    const projectDeletion: CanonicalSnapshot = {
      type: 'project_deleted',
      projectUuid: PROJECT_UUID,
      deletedAt: '2026-01-01T00:00:00.000Z',
    };

    const forward = orderCanonicalSnapshotsForMerge([projectDeletion, first, project, second]);
    const reverse = orderCanonicalSnapshotsForMerge([second, project, first, projectDeletion]);

    expect(forward.map(snapshotEntityKey)).toEqual(reverse.map(snapshotEntityKey));
    expect(forward.map(snapshotEntityKey)).toEqual([
      `project:${PROJECT_UUID}`,
      `plan:${secondUuid}`,
      `plan:${firstUuid}`,
      `project:${PROJECT_UUID}:deleted`,
    ]);
  });
});

function createTestDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function planSnapshot(
  uuid: string,
  planId: number,
  references: {
    discoveredFrom?: string;
    parentUuid?: string;
    basePlanUuid?: string;
    dependencyUuids?: string[];
  } = {}
): CanonicalPlanSnapshot {
  return {
    type: 'plan',
    projectUuid: PROJECT_UUID,
    plan: {
      uuid,
      planId,
      title: `Plan ${planId}`,
      goal: null,
      note: null,
      details: null,
      status: 'pending',
      priority: null,
      branch: null,
      simple: null,
      tdd: null,
      discoveredFrom: references.discoveredFrom ?? null,
      basePlanUuid: references.basePlanUuid ?? null,
      issue: null,
      pullRequest: null,
      assignedTo: null,
      baseBranch: null,
      temp: null,
      docs: null,
      changedFiles: null,
      planGeneratedAt: null,
      reviewIssues: null,
      parentUuid: references.parentUuid ?? null,
      epic: false,
      revision: 1,
      tasks: [],
      dependencyUuids: references.dependencyUuids ?? [],
      tags: [],
    },
  };
}

function snapshotEntityKey(snapshot: CanonicalSnapshot): string {
  switch (snapshot.type) {
    case 'project':
      return `project:${snapshot.project.uuid}`;
    case 'plan':
      return `plan:${snapshot.plan.uuid}`;
    case 'plan_deleted':
      return `plan:${snapshot.planUuid}:deleted`;
    case 'project_deleted':
      return `project:${snapshot.projectUuid}:deleted`;
    case 'never_existed':
      return snapshot.entityKey;
    case 'project_setting':
      return `project_setting:${snapshot.projectUuid}:${snapshot.setting}`;
  }
}
