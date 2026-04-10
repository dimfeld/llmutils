import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export type BranchMergeRequirementSourceKind = 'legacy_branch_protection' | 'ruleset';

export interface BranchMergeRequirementsRow {
  id: number;
  owner: string;
  repo: string;
  branch_name: string;
  last_fetched_at: string;
  created_at: string;
  updated_at: string;
}

export interface BranchMergeRequirementSourceRow {
  id: number;
  branch_merge_requirements_id: number;
  source_kind: BranchMergeRequirementSourceKind;
  source_id: number;
  source_name: string | null;
  strict: number | null;
}

export interface BranchMergeRequirementCheckRow {
  id: number;
  branch_merge_requirement_source_id: number;
  context: string;
  integration_id: number;
}

export interface StoredBranchRequiredCheckInput {
  context: string;
  integrationId?: number | null;
}

export interface StoredBranchMergeRequirementSourceInput {
  sourceKind: BranchMergeRequirementSourceKind;
  sourceId: number;
  sourceName?: string | null;
  strict?: boolean | null;
  checks: StoredBranchRequiredCheckInput[];
}

export interface UpsertBranchMergeRequirementsInput {
  owner: string;
  repo: string;
  branchName: string;
  lastFetchedAt: string;
  requirements: StoredBranchMergeRequirementSourceInput[];
}

export interface BranchMergeRequirementSourceDetail {
  source: BranchMergeRequirementSourceRow;
  checks: Array<
    Omit<BranchMergeRequirementCheckRow, 'integration_id'> & {
      integration_id: number | null;
    }
  >;
}

export interface BranchMergeRequirementsDetail {
  branch: BranchMergeRequirementsRow;
  requirements: BranchMergeRequirementSourceDetail[];
}

function normalizeIntegrationId(integrationId: number | null | undefined): number {
  return integrationId ?? -1;
}

function denormalizeCheckRow(
  row: BranchMergeRequirementCheckRow
): BranchMergeRequirementSourceDetail['checks'][number] {
  return {
    ...row,
    integration_id: row.integration_id >= 0 ? row.integration_id : null,
  };
}

export function getBranchMergeRequirements(
  db: Database,
  owner: string,
  repo: string,
  branchName: string
): BranchMergeRequirementsDetail | null {
  const branch =
    (db
      .prepare(
        `
          SELECT *
          FROM branch_merge_requirements
          WHERE owner = ?
            AND repo = ?
            AND branch_name = ?
        `
      )
      .get(owner, repo, branchName) as BranchMergeRequirementsRow | null) ?? null;

  if (!branch) {
    return null;
  }

  const sources = db
    .prepare(
      `
        SELECT *
        FROM branch_merge_requirement_source
        WHERE branch_merge_requirements_id = ?
        ORDER BY source_kind, source_id
      `
    )
    .all(branch.id) as BranchMergeRequirementSourceRow[];

  if (sources.length === 0) {
    return {
      branch,
      requirements: [],
    };
  }

  const sourceIds = sources.map((source) => source.id);
  const placeholders = sourceIds.map(() => '?').join(', ');
  const checkRows = db
    .prepare(
      `
        SELECT *
        FROM branch_merge_requirement_check
        WHERE branch_merge_requirement_source_id IN (${placeholders})
        ORDER BY context, integration_id, id
      `
    )
    .all(...sourceIds) as BranchMergeRequirementCheckRow[];

  const checksBySourceId = new Map<number, BranchMergeRequirementSourceDetail['checks']>();
  for (const checkRow of checkRows) {
    const checks = checksBySourceId.get(checkRow.branch_merge_requirement_source_id);
    if (checks) {
      checks.push(denormalizeCheckRow(checkRow));
    } else {
      checksBySourceId.set(checkRow.branch_merge_requirement_source_id, [
        denormalizeCheckRow(checkRow),
      ]);
    }
  }

  return {
    branch,
    requirements: sources.map((source) => ({
      source,
      checks: checksBySourceId.get(source.id) ?? [],
    })),
  };
}

export function upsertBranchMergeRequirements(
  db: Database,
  input: UpsertBranchMergeRequirementsInput
): BranchMergeRequirementsDetail {
  const upsertInTransaction = db.transaction(
    (nextInput: UpsertBranchMergeRequirementsInput): BranchMergeRequirementsDetail => {
      db.prepare(
        `
          INSERT INTO branch_merge_requirements (
            owner,
            repo,
            branch_name,
            last_fetched_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
          ON CONFLICT(owner, repo, branch_name) DO UPDATE SET
            last_fetched_at = excluded.last_fetched_at,
            updated_at = ${SQL_NOW_ISO_UTC}
        `
      ).run(nextInput.owner, nextInput.repo, nextInput.branchName, nextInput.lastFetchedAt);

      const branchRow = db
        .prepare(
          `
            SELECT id
            FROM branch_merge_requirements
            WHERE owner = ?
              AND repo = ?
              AND branch_name = ?
          `
        )
        .get(nextInput.owner, nextInput.repo, nextInput.branchName) as { id: number } | null;

      if (!branchRow) {
        throw new Error(
          `Failed to upsert branch merge requirements for ${nextInput.owner}/${nextInput.repo}:${nextInput.branchName}`
        );
      }

      db.prepare(
        `
          DELETE FROM branch_merge_requirement_source
          WHERE branch_merge_requirements_id = ?
        `
      ).run(branchRow.id);

      const insertSource = db.prepare(
        `
          INSERT INTO branch_merge_requirement_source (
            branch_merge_requirements_id,
            source_kind,
            source_id,
            source_name,
            strict
          ) VALUES (?, ?, ?, ?, ?)
        `
      );
      const insertCheck = db.prepare(
        `
          INSERT INTO branch_merge_requirement_check (
            branch_merge_requirement_source_id,
            context,
            integration_id
          ) VALUES (?, ?, ?)
        `
      );

      for (const requirement of nextInput.requirements) {
        const result = insertSource.run(
          branchRow.id,
          requirement.sourceKind,
          requirement.sourceId,
          requirement.sourceName ?? null,
          requirement.strict === undefined || requirement.strict === null
            ? null
            : requirement.strict
              ? 1
              : 0
        );
        const sourceId = Number(result.lastInsertRowid);

        for (const check of requirement.checks) {
          insertCheck.run(sourceId, check.context, normalizeIntegrationId(check.integrationId));
        }
      }

      const detail = getBranchMergeRequirements(
        db,
        nextInput.owner,
        nextInput.repo,
        nextInput.branchName
      );
      if (!detail) {
        throw new Error(
          `Failed to load branch merge requirements for ${nextInput.owner}/${nextInput.repo}:${nextInput.branchName}`
        );
      }

      return detail;
    }
  );

  return upsertInTransaction.immediate(input);
}
