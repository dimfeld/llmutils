import type { Database } from 'bun:sqlite';

import type { PlanDependencyRow, PlanRow, PlanTagRow, PlanTaskRow } from '../db/plan.js';
import type { PlanReviewIssueRow } from '../db/plan_review_issue.js';
import type { Project } from '../db/project.js';
import { getOrCreateProject } from '../db/project.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import {
  getOrCreateClockRow,
  setPeerCursor,
  type SyncFieldClockRow,
  type SyncTombstoneRow,
} from '../db/sync_schema.js';
import {
  edgeClockIsPresent,
  getEdgeClock,
  writeEdgeAddClock,
  writeEdgeRemoveClock,
  type SyncEdgeClockRow,
} from './edge_clock.js';
import { formatHlc, parseHlc, type Hlc } from './hlc.js';
import { getLocalGenerator } from './op_emission.js';
import { registerPeerNode } from './node_identity.js';
import {
  PLAN_LWW_FIELD_NAMES,
  PLAN_TASK_LWW_FIELD_NAMES,
  PROJECT_SETTING_LWW_FIELD_NAME,
  REVIEW_ISSUE_LWW_FIELD_NAMES,
  getProjectSyncIdentity,
} from './op_emission.js';

type SqlValue = string | number | bigint | boolean | null;

export interface SnapshotProject {
  identity: string;
  row: Project;
}

export interface SnapshotProjectSetting {
  projectIdentity: string;
  setting: string;
  value: string;
}

export interface PeerSnapshot {
  version: 1;
  senderNodeId: string;
  highWaterSeq: number;
  highWaterHlc: string;
  projects: SnapshotProject[];
  plans: PlanRow[];
  tasks: PlanTaskRow[];
  reviewIssues: PlanReviewIssueRow[];
  dependencies: PlanDependencyRow[];
  tags: PlanTagRow[];
  projectSettings: SnapshotProjectSetting[];
  fieldClocks: SyncFieldClockRow[];
  edgeClocks: SyncEdgeClockRow[];
  tombstones: SyncTombstoneRow[];
}

const PLAN_FIELDS = PLAN_LWW_FIELD_NAMES;
const TASK_FIELDS = PLAN_TASK_LWW_FIELD_NAMES;
const REVIEW_ISSUE_FIELDS = REVIEW_ISSUE_LWW_FIELD_NAMES;

function currentHighWaterSeq(db: Database): number {
  const row = db.prepare('SELECT MAX(seq) AS seq FROM sync_op_log').get() as {
    seq: number | null;
  };
  return row.seq ?? 0;
}

function currentHighWaterHlc(db: Database): string {
  const clock = getOrCreateClockRow(db);
  return formatHlc({ physicalMs: clock.physical_ms, logical: clock.logical });
}

export function buildPeerSnapshot(db: Database): PeerSnapshot {
  const build = db.transaction((): PeerSnapshot => {
    const localNode = db.prepare('SELECT node_id FROM sync_node WHERE is_local = 1').get() as {
      node_id: string;
    } | null;
    if (!localNode) {
      throw new Error('Local sync node is not initialized');
    }

    const projects = (db.prepare('SELECT * FROM project ORDER BY id').all() as Project[]).map(
      (project) => ({
        identity: getProjectSyncIdentity(db, project.id),
        row: project,
      })
    );

    const projectSettings = db
      .prepare(
        `
          SELECT p.repository_id AS projectIdentity, ps.setting, ps.value
          FROM project_setting ps
          JOIN project p ON p.id = ps.project_id
          ORDER BY p.repository_id, ps.setting
        `
      )
      .all() as SnapshotProjectSetting[];

    return {
      version: 1,
      senderNodeId: localNode.node_id,
      highWaterSeq: currentHighWaterSeq(db),
      highWaterHlc: currentHighWaterHlc(db),
      projects,
      plans: db.prepare('SELECT * FROM plan ORDER BY project_id, plan_id, uuid').all() as PlanRow[],
      tasks: db
        .prepare(
          'SELECT * FROM plan_task WHERE deleted_hlc IS NULL ORDER BY plan_uuid, order_key, created_hlc, created_node_id, uuid'
        )
        .all() as PlanTaskRow[],
      reviewIssues: db
        .prepare(
          'SELECT * FROM plan_review_issue WHERE deleted_hlc IS NULL ORDER BY plan_uuid, order_key, created_hlc, created_node_id, uuid'
        )
        .all() as PlanReviewIssueRow[],
      dependencies: db
        .prepare('SELECT * FROM plan_dependency ORDER BY plan_uuid, depends_on_uuid')
        .all() as PlanDependencyRow[],
      tags: db.prepare('SELECT * FROM plan_tag ORDER BY plan_uuid, tag').all() as PlanTagRow[],
      projectSettings,
      fieldClocks: db.prepare('SELECT * FROM sync_field_clock').all() as SyncFieldClockRow[],
      edgeClocks: db.prepare('SELECT * FROM sync_edge_clock').all() as SyncEdgeClockRow[],
      tombstones: db.prepare('SELECT * FROM sync_tombstone').all() as SyncTombstoneRow[],
    };
  });

  return build.immediate();
}

function sqlValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function compareClockParts(
  leftHlc: Hlc,
  leftNodeId: string,
  rightHlc: Hlc,
  rightNodeId: string
): number {
  const byPhysical = leftHlc.physicalMs - rightHlc.physicalMs;
  if (byPhysical !== 0) return byPhysical;
  const byLogical = leftHlc.logical - rightHlc.logical;
  if (byLogical !== 0) return byLogical;
  return leftNodeId.localeCompare(rightNodeId);
}

function incomingFieldClockWins(db: Database, clock: SyncFieldClockRow): boolean {
  const existing = db
    .prepare(
      `
        SELECT *
        FROM sync_field_clock
        WHERE entity_type = ?
          AND entity_id = ?
          AND field_name = ?
      `
    )
    .get(clock.entity_type, clock.entity_id, clock.field_name) as SyncFieldClockRow | null;
  if (!existing) return true;
  return (
    compareClockParts(
      { physicalMs: clock.hlc_physical_ms, logical: clock.hlc_logical },
      clock.node_id,
      { physicalMs: existing.hlc_physical_ms, logical: existing.hlc_logical },
      existing.node_id
    ) > 0
  );
}

function mergeFieldClock(db: Database, clock: SyncFieldClockRow): void {
  db.prepare(
    `
      INSERT INTO sync_field_clock (
        entity_type,
        entity_id,
        field_name,
        hlc_physical_ms,
        hlc_logical,
        node_id,
        deleted,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
        hlc_physical_ms = excluded.hlc_physical_ms,
        hlc_logical = excluded.hlc_logical,
        node_id = excluded.node_id,
        deleted = excluded.deleted,
        updated_at = excluded.updated_at
      WHERE excluded.hlc_physical_ms > sync_field_clock.hlc_physical_ms
         OR (
           excluded.hlc_physical_ms = sync_field_clock.hlc_physical_ms
           AND excluded.hlc_logical > sync_field_clock.hlc_logical
         )
         OR (
           excluded.hlc_physical_ms = sync_field_clock.hlc_physical_ms
           AND excluded.hlc_logical = sync_field_clock.hlc_logical
           AND excluded.node_id > sync_field_clock.node_id
         )
    `
  ).run(
    clock.entity_type,
    clock.entity_id,
    clock.field_name,
    clock.hlc_physical_ms,
    clock.hlc_logical,
    clock.node_id,
    clock.deleted,
    clock.updated_at
  );
}

function hasTombstone(db: Database, entityType: string, entityId: string): boolean {
  return (
    db
      .prepare('SELECT 1 FROM sync_tombstone WHERE entity_type = ? AND entity_id = ?')
      .get(entityType, entityId) !== null
  );
}

function mergeTombstone(db: Database, tombstone: SyncTombstoneRow): boolean {
  const existing = db
    .prepare('SELECT * FROM sync_tombstone WHERE entity_type = ? AND entity_id = ?')
    .get(tombstone.entity_type, tombstone.entity_id) as SyncTombstoneRow | null;
  const incomingWins =
    !existing ||
    compareClockParts(
      { physicalMs: tombstone.hlc_physical_ms, logical: tombstone.hlc_logical },
      tombstone.node_id,
      { physicalMs: existing.hlc_physical_ms, logical: existing.hlc_logical },
      existing.node_id
    ) >= 0;
  if (!incomingWins) return false;

  db.prepare(
    `
      INSERT INTO sync_tombstone (
        entity_type,
        entity_id,
        hlc_physical_ms,
        hlc_logical,
        node_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        hlc_physical_ms = excluded.hlc_physical_ms,
        hlc_logical = excluded.hlc_logical,
        node_id = excluded.node_id,
        created_at = excluded.created_at
    `
  ).run(
    tombstone.entity_type,
    tombstone.entity_id,
    tombstone.hlc_physical_ms,
    tombstone.hlc_logical,
    tombstone.node_id,
    tombstone.created_at
  );
  applyTombstoneEffect(db, tombstone);
  return true;
}

function applyTombstoneEffect(db: Database, tombstone: SyncTombstoneRow): void {
  if (tombstone.entity_type === 'plan') {
    db.prepare('DELETE FROM plan WHERE uuid = ?').run(tombstone.entity_id);
  } else if (tombstone.entity_type === 'plan_task') {
    const hlc = formatHlc({
      physicalMs: tombstone.hlc_physical_ms,
      logical: tombstone.hlc_logical,
    });
    db.prepare(
      'UPDATE plan_task SET deleted_hlc = ?, updated_hlc = ?, task_index = -id WHERE uuid = ?'
    ).run(hlc, hlc, tombstone.entity_id);
  } else if (tombstone.entity_type === 'plan_review_issue') {
    const hlc = formatHlc({
      physicalMs: tombstone.hlc_physical_ms,
      logical: tombstone.hlc_logical,
    });
    db.prepare(
      `UPDATE plan_review_issue SET deleted_hlc = ?, updated_hlc = ?, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
    ).run(hlc, hlc, tombstone.entity_id);
  } else if (tombstone.entity_type === 'project_setting') {
    const separator = tombstone.entity_id.lastIndexOf(':');
    if (separator <= 0) return;
    const projectIdentity = tombstone.entity_id.slice(0, separator);
    const setting = tombstone.entity_id.slice(separator + 1);
    const project = getOrCreateProject(db, projectIdentity);
    db.prepare('DELETE FROM project_setting WHERE project_id = ? AND setting = ?').run(
      project.id,
      setting
    );
  }
}

function clockMap(clocks: SyncFieldClockRow[]): Map<string, SyncFieldClockRow> {
  return new Map(
    clocks.map((clock) => [`${clock.entity_type}:${clock.entity_id}:${clock.field_name}`, clock])
  );
}

function fieldClock(
  clocks: Map<string, SyncFieldClockRow>,
  entityType: string,
  entityId: string,
  fieldName: string
): SyncFieldClockRow | null {
  return clocks.get(`${entityType}:${entityId}:${fieldName}`) ?? null;
}

function updateWinningFields(
  db: Database,
  tableName: string,
  idColumn: string,
  entityType: string,
  entityId: string,
  fields: readonly string[],
  source: Record<string, unknown>,
  clocks: Map<string, SyncFieldClockRow>
): void {
  for (const field of fields) {
    const clock = fieldClock(clocks, entityType, entityId, field);
    if (!clock || !incomingFieldClockWins(db, clock)) {
      continue;
    }
    db.prepare(`UPDATE ${tableName} SET ${field} = ? WHERE ${idColumn} = ?`).run(
      sqlValue(source[field]),
      entityId
    );
    mergeFieldClock(db, clock);
  }
}

function upsertProject(db: Database, project: SnapshotProject): number {
  const created = getOrCreateProject(db, project.identity, {
    remoteUrl: project.row.remote_url,
    lastGitRoot: project.row.last_git_root,
    externalConfigPath: project.row.external_config_path,
    externalTasksDir: project.row.external_tasks_dir,
    remoteLabel: project.row.remote_label,
    highestPlanId: project.row.highest_plan_id,
  });
  db.prepare(
    `
      UPDATE project
      SET highest_plan_id = max(highest_plan_id, ?),
          updated_at = ${SQL_NOW_ISO_UTC}
      WHERE id = ?
    `
  ).run(project.row.highest_plan_id, created.id);
  return created.id;
}

function importPlans(
  db: Database,
  snapshot: PeerSnapshot,
  projectIdMap: Map<number, number>,
  clocks: Map<string, SyncFieldClockRow>
): void {
  const insert = db.prepare(
    `
      INSERT INTO plan (
        uuid,
        project_id,
        plan_id,
        title,
        goal,
        note,
        details,
        status,
        priority,
        branch,
        simple,
        tdd,
        discovered_from,
        issue,
        pull_request,
        assigned_to,
        base_branch,
        base_commit,
        base_change_id,
        temp,
        docs,
        changed_files,
        plan_generated_at,
        docs_updated_at,
        lessons_applied_at,
        parent_uuid,
        epic,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  );
  for (const plan of snapshot.plans) {
    if (hasTombstone(db, 'plan', plan.uuid)) continue;
    const projectId = projectIdMap.get(plan.project_id);
    if (!projectId) continue;
    const existing = db.prepare('SELECT uuid FROM plan WHERE uuid = ?').get(plan.uuid);
    if (!existing) {
      insert.run(
        plan.uuid,
        projectId,
        plan.plan_id,
        plan.title,
        plan.goal,
        plan.note,
        plan.details,
        plan.status,
        plan.priority,
        plan.branch,
        plan.simple,
        plan.tdd,
        plan.discovered_from,
        plan.issue,
        plan.pull_request,
        plan.assigned_to,
        plan.base_branch,
        plan.base_commit,
        plan.base_change_id,
        plan.temp,
        plan.docs,
        plan.changed_files,
        plan.plan_generated_at,
        plan.docs_updated_at,
        plan.lessons_applied_at,
        plan.parent_uuid,
        plan.epic,
        plan.created_at,
        plan.updated_at
      );
    } else {
      updateWinningFields(
        db,
        'plan',
        'uuid',
        'plan',
        plan.uuid,
        PLAN_FIELDS,
        plan as unknown as Record<string, unknown>,
        clocks
      );
    }
  }
}

function nextTaskIndex(db: Database, planUuid: string): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(task_index), -1) AS maxTaskIndex FROM plan_task WHERE plan_uuid = ?'
    )
    .get(planUuid) as { maxTaskIndex: number };
  return row.maxTaskIndex + 1;
}

function renumberPlanTaskIndices(db: Database, planUuid: string): void {
  db.prepare(
    'UPDATE plan_task SET task_index = -id WHERE plan_uuid = ? AND deleted_hlc IS NULL'
  ).run(planUuid);
  const rows = db
    .prepare(
      'SELECT uuid FROM plan_task WHERE plan_uuid = ? AND deleted_hlc IS NULL ORDER BY order_key, created_hlc, created_node_id, uuid'
    )
    .all(planUuid) as Array<{ uuid: string }>;
  const update = db.prepare('UPDATE plan_task SET task_index = ? WHERE uuid = ?');
  rows.forEach((row, index) => update.run(index, row.uuid));
}

function importTasks(
  db: Database,
  tasks: PlanTaskRow[],
  clocks: Map<string, SyncFieldClockRow>
): void {
  const touchedPlanUuids = new Set<string>();
  const insert = db.prepare(
    `
      INSERT INTO plan_task (
        uuid,
        plan_uuid,
        task_index,
        order_key,
        title,
        description,
        done,
        created_node_id,
        created_hlc,
        updated_hlc,
        deleted_hlc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `
  );
  for (const task of tasks) {
    if (hasTombstone(db, 'plan_task', task.uuid) || hasTombstone(db, 'plan', task.plan_uuid)) {
      continue;
    }
    if (db.prepare('SELECT 1 FROM plan WHERE uuid = ?').get(task.plan_uuid) === null) continue;
    const existing = db.prepare('SELECT uuid FROM plan_task WHERE uuid = ?').get(task.uuid);
    if (!existing) {
      insert.run(
        task.uuid,
        task.plan_uuid,
        nextTaskIndex(db, task.plan_uuid),
        task.order_key,
        task.title,
        task.description,
        task.done,
        task.created_node_id,
        task.created_hlc,
        task.updated_hlc
      );
    } else {
      updateWinningFields(
        db,
        'plan_task',
        'uuid',
        'plan_task',
        task.uuid,
        TASK_FIELDS,
        task as unknown as Record<string, unknown>,
        clocks
      );
    }
    touchedPlanUuids.add(task.plan_uuid);
  }
  for (const planUuid of touchedPlanUuids) {
    renumberPlanTaskIndices(db, planUuid);
  }
}

function importReviewIssues(
  db: Database,
  issues: PlanReviewIssueRow[],
  clocks: Map<string, SyncFieldClockRow>
): void {
  const insert = db.prepare(
    `
      INSERT INTO plan_review_issue (
        uuid,
        plan_uuid,
        order_key,
        severity,
        category,
        content,
        file,
        line,
        suggestion,
        source,
        source_ref,
        created_node_id,
        created_hlc,
        updated_hlc,
        deleted_hlc,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `
  );
  for (const issue of issues) {
    if (
      hasTombstone(db, 'plan_review_issue', issue.uuid) ||
      hasTombstone(db, 'plan', issue.plan_uuid)
    ) {
      continue;
    }
    if (db.prepare('SELECT 1 FROM plan WHERE uuid = ?').get(issue.plan_uuid) === null) continue;
    const existing = db
      .prepare('SELECT uuid FROM plan_review_issue WHERE uuid = ?')
      .get(issue.uuid);
    if (!existing) {
      insert.run(
        issue.uuid,
        issue.plan_uuid,
        issue.order_key,
        issue.severity,
        issue.category,
        issue.content,
        issue.file,
        issue.line,
        issue.suggestion,
        issue.source,
        issue.source_ref,
        issue.created_node_id,
        issue.created_hlc,
        issue.updated_hlc,
        issue.created_at,
        issue.updated_at
      );
    } else {
      updateWinningFields(
        db,
        'plan_review_issue',
        'uuid',
        'plan_review_issue',
        issue.uuid,
        REVIEW_ISSUE_FIELDS,
        issue as unknown as Record<string, unknown>,
        clocks
      );
    }
  }
}

function importProjectSettings(
  db: Database,
  settings: SnapshotProjectSetting[],
  clocks: Map<string, SyncFieldClockRow>
): void {
  for (const setting of settings) {
    const entityId = `${setting.projectIdentity}:${setting.setting}`;
    if (hasTombstone(db, 'project_setting', entityId)) continue;
    const clock = fieldClock(clocks, 'project_setting', entityId, PROJECT_SETTING_LWW_FIELD_NAME);
    if (!clock || !incomingFieldClockWins(db, clock)) continue;
    const project = getOrCreateProject(db, setting.projectIdentity);
    db.prepare(
      'INSERT OR REPLACE INTO project_setting (project_id, setting, value) VALUES (?, ?, ?)'
    ).run(project.id, setting.setting, setting.value);
    mergeFieldClock(db, clock);
  }
}

function mergeEdgeClocks(db: Database, edgeClocks: SyncEdgeClockRow[]): void {
  for (const clock of edgeClocks) {
    if (clock.add_hlc && clock.add_node_id) {
      writeEdgeAddClock(db, {
        entityType: clock.entity_type,
        edgeKey: clock.edge_key,
        hlc: parseHlc(clock.add_hlc),
        nodeId: clock.add_node_id,
      });
    }
    if (clock.remove_hlc && clock.remove_node_id) {
      writeEdgeRemoveClock(db, {
        entityType: clock.entity_type,
        edgeKey: clock.edge_key,
        hlc: parseHlc(clock.remove_hlc),
        nodeId: clock.remove_node_id,
      });
    }
  }
}

function reconcileEdges(db: Database, snapshot: PeerSnapshot): void {
  for (const dependency of snapshot.dependencies) {
    const edgeKey = `${dependency.plan_uuid}->${dependency.depends_on_uuid}`;
    const present = edgeClockIsPresent(getEdgeClock(db, 'plan_dependency', edgeKey));
    if (
      present &&
      !hasTombstone(db, 'plan', dependency.plan_uuid) &&
      !hasTombstone(db, 'plan', dependency.depends_on_uuid) &&
      db.prepare('SELECT 1 FROM plan WHERE uuid = ?').get(dependency.plan_uuid) !== null &&
      db.prepare('SELECT 1 FROM plan WHERE uuid = ?').get(dependency.depends_on_uuid) !== null
    ) {
      db.prepare(
        'INSERT OR IGNORE INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)'
      ).run(dependency.plan_uuid, dependency.depends_on_uuid);
    } else {
      db.prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?').run(
        dependency.plan_uuid,
        dependency.depends_on_uuid
      );
    }
  }

  // Purge locally live edges whose merged clock now says absent (remove-wins).
  // An edge can be absent from snapshot.dependencies because it was removed on the
  // sender; after mergeEdgeClocks runs, the local edge clock reflects the newer
  // remote remove-clock and edgeClockIsPresent returns false.
  const liveDeps = db
    .prepare('SELECT plan_uuid, depends_on_uuid FROM plan_dependency')
    .all() as Array<{ plan_uuid: string; depends_on_uuid: string }>;
  for (const dep of liveDeps) {
    const edgeKey = `${dep.plan_uuid}->${dep.depends_on_uuid}`;
    if (!edgeClockIsPresent(getEdgeClock(db, 'plan_dependency', edgeKey))) {
      db.prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?').run(
        dep.plan_uuid,
        dep.depends_on_uuid
      );
    }
  }

  for (const tag of snapshot.tags) {
    const edgeKey = `${tag.plan_uuid}#${tag.tag}`;
    const present = edgeClockIsPresent(getEdgeClock(db, 'plan_tag', edgeKey));
    if (
      present &&
      !hasTombstone(db, 'plan', tag.plan_uuid) &&
      db.prepare('SELECT 1 FROM plan WHERE uuid = ?').get(tag.plan_uuid) !== null
    ) {
      db.prepare('INSERT OR IGNORE INTO plan_tag (plan_uuid, tag) VALUES (?, ?)').run(
        tag.plan_uuid,
        tag.tag
      );
    } else {
      db.prepare('DELETE FROM plan_tag WHERE plan_uuid = ? AND tag = ?').run(
        tag.plan_uuid,
        tag.tag
      );
    }
  }

  // Same cleanup for tags
  const liveTags = db
    .prepare('SELECT plan_uuid, tag FROM plan_tag')
    .all() as Array<{ plan_uuid: string; tag: string }>;
  for (const liveTag of liveTags) {
    const edgeKey = `${liveTag.plan_uuid}#${liveTag.tag}`;
    if (!edgeClockIsPresent(getEdgeClock(db, 'plan_tag', edgeKey))) {
      db.prepare('DELETE FROM plan_tag WHERE plan_uuid = ? AND tag = ?').run(
        liveTag.plan_uuid,
        liveTag.tag
      );
    }
  }
}

function observeSnapshotHlc(db: Database, highWaterHlc: string): void {
  const parsed = parseHlc(highWaterHlc);
  getLocalGenerator(db).generator.observe(parsed, Date.now(), db);
}

export function applyPeerSnapshot(db: Database, peerNodeId: string, snapshot: PeerSnapshot): void {
  if (snapshot.version !== 1) {
    throw new Error(`Unsupported peer snapshot version: ${snapshot.version}`);
  }
  if (snapshot.senderNodeId !== peerNodeId) {
    throw new Error(`Snapshot sender ${snapshot.senderNodeId} does not match peer ${peerNodeId}`);
  }

  // Ensure the peer is registered so sync_peer_cursor FK constraints are satisfied.
  // registerPeerNode is idempotent and safe to call from within a transaction
  // (bun:sqlite nested transactions use savepoints).
  registerPeerNode(db, { nodeId: peerNodeId, nodeType: 'main' });

  const apply = db.transaction((nextSnapshot: PeerSnapshot): void => {
    const clocks = clockMap(nextSnapshot.fieldClocks);
    const projectIdMap = new Map<number, number>();

    observeSnapshotHlc(db, nextSnapshot.highWaterHlc);

    for (const tombstone of nextSnapshot.tombstones) {
      mergeTombstone(db, tombstone);
    }

    for (const project of nextSnapshot.projects) {
      projectIdMap.set(project.row.id, upsertProject(db, project));
    }
    importPlans(db, nextSnapshot, projectIdMap, clocks);
    importTasks(db, nextSnapshot.tasks, clocks);
    importReviewIssues(db, nextSnapshot.reviewIssues, clocks);
    importProjectSettings(db, nextSnapshot.projectSettings, clocks);

    for (const clock of nextSnapshot.fieldClocks) {
      mergeFieldClock(db, clock);
    }
    mergeEdgeClocks(db, nextSnapshot.edgeClocks);
    reconcileEdges(db, nextSnapshot);

    setPeerCursor(db, peerNodeId, 'pull', nextSnapshot.highWaterSeq.toString(), null);
  });

  apply.immediate(snapshot);
}
