import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { warn } from '../logging.js';
import { getPlanByUuid, getPlansByProject, type PlanRow } from './db/plan.js';
import { getProjectById } from './db/project.js';
import { generatePlanFileContent } from './plans.js';
import {
  getMaterializedPlanPath,
  getPlanSchemaFromRow,
  getShadowPlanPathForFile,
  MATERIALIZED_DIR,
  parseMaterializedFrontmatterFromContent,
  parseMaterializedPlanRoleFromContent,
} from './plan_materialize.js';

export function refreshExistingPrimaryMaterializedPlans(
  db: Database,
  planUuids: Iterable<string>
): string[] {
  const refreshedPaths: string[] = [];
  const uniquePlanUuids = [...new Set(planUuids)];

  for (const planUuid of uniquePlanUuids) {
    try {
      const row = getPlanByUuid(db, planUuid);
      const projectId = row?.project_id ?? findProjectionProjectIdForPlanUuid(db, planUuid);
      if (projectId === null) {
        continue;
      }
      const project = getProjectById(db, projectId);
      if (!project?.last_git_root) {
        continue;
      }

      const planId =
        row?.plan_id ?? findPlanIdForExistingMaterialization(project.last_git_root, planUuid);
      if (planId === null) {
        continue;
      }

      const filePath = getMaterializedPlanPath(project.last_git_root, planId);
      if (readMaterializedPlanRoleSync(filePath) !== 'primary') {
        continue;
      }

      if (isPrimaryMaterializedPlanDirty(filePath)) {
        continue;
      }

      if (!row) {
        unlinkMaterializedPrimary(filePath);
        refreshedPaths.push(filePath);
        continue;
      }

      const uuidToPlanId = buildUuidToPlanIdMap(getPlansByProject(db, projectId));
      const content = generatePlanFileContent(
        getPlanSchemaFromRow(row, uuidToPlanId, 'primary', db)
      );
      writeFileSync(filePath, content, 'utf8');
      writeFileSync(getShadowPlanPathForFile(filePath), content, 'utf8');
      refreshedPaths.push(filePath);
    } catch (error) {
      warn(`Failed to refresh materialized projection for plan ${planUuid}: ${error as Error}`);
    }
  }

  return refreshedPaths;
}

function readMaterializedPlanRoleSync(filePath: string): 'primary' | 'reference' | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return parseMaterializedPlanRoleFromContent(readFileSync(filePath, 'utf8'));
  } catch {
    return 'primary';
  }
}

function unlinkMaterializedPrimary(filePath: string): void {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
  const shadowPath = getShadowPlanPathForFile(filePath);
  if (existsSync(shadowPath)) {
    unlinkSync(shadowPath);
  }
}

function isPrimaryMaterializedPlanDirty(filePath: string): boolean {
  const shadowPath = getShadowPlanPathForFile(filePath);
  if (!existsSync(shadowPath)) {
    return true;
  }

  try {
    return readFileSync(filePath, 'utf8') !== readFileSync(shadowPath, 'utf8');
  } catch {
    return true;
  }
}

function buildUuidToPlanIdMap(rows: PlanRow[]): Map<string, number> {
  const uuidToPlanId = new Map<string, number>();
  for (const row of rows) {
    uuidToPlanId.set(row.uuid, row.plan_id);
  }
  return uuidToPlanId;
}

function findProjectionProjectIdForPlanUuid(db: Database, planUuid: string): number | null {
  const ref = db
    .prepare(
      `
        SELECT p.id AS project_id
        FROM sync_operation_plan_ref ref
        JOIN sync_operation op ON op.operation_uuid = ref.operation_uuid
        JOIN project p ON p.uuid = op.project_uuid
        WHERE ref.plan_uuid = ?
        ORDER BY op.local_sequence DESC
        LIMIT 1
      `
    )
    .get(planUuid) as { project_id: number } | null;
  if (ref?.project_id) {
    return ref.project_id;
  }

  const tombstone = db
    .prepare(
      `
        SELECT p.id AS project_id
        FROM sync_tombstone t
        JOIN project p ON p.uuid = t.project_uuid
        WHERE t.entity_type = 'plan'
          AND t.entity_key = ?
        LIMIT 1
      `
    )
    .get(`plan:${planUuid}`) as { project_id: number } | null;
  return tombstone?.project_id ?? null;
}

function findPlanIdForExistingMaterialization(repoRoot: string, planUuid: string): number | null {
  const dir = path.join(repoRoot, MATERIALIZED_DIR);
  if (!existsSync(dir)) {
    return null;
  }
  for (const entry of readdirSync(dir)) {
    const match = /^(\d+)\.plan\.md$/.exec(entry);
    if (!match) {
      continue;
    }
    const filePath = path.join(dir, entry);
    if (readMaterializedPlanRoleSync(filePath) !== 'primary') {
      continue;
    }
    const frontmatter = readMaterializedFrontmatterSync(filePath);
    if (frontmatter?.uuid === planUuid) {
      return Number(match[1]);
    }
  }
  return null;
}

function readMaterializedFrontmatterSync(filePath: string): Record<string, unknown> | null {
  try {
    return parseMaterializedFrontmatterFromContent(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}
