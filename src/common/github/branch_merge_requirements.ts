import { getOctokit } from './octokit.js';

export type BranchMergeRequirementSourceKind = 'legacy_branch_protection' | 'ruleset';

export interface BranchRequiredCheck {
  context: string;
  integrationId: number | null;
}

export interface BranchMergeRequirementSource {
  sourceKind: BranchMergeRequirementSourceKind;
  sourceId: number;
  sourceName: string | null;
  strict: boolean | null;
  checks: BranchRequiredCheck[];
}

export interface BranchMergeRequirementsSnapshot {
  owner: string;
  repo: string;
  branchName: string;
  requirements: BranchMergeRequirementSource[];
}

interface LegacyRequiredStatusChecksResponse {
  strict: boolean;
  contexts?: string[];
  checks?: Array<{
    context: string;
    app_id?: number | null;
  }>;
}

interface RulesBranchRuleResponse {
  type: string;
  ruleset_id?: number | null;
  ruleset_name?: string | null;
  parameters?: {
    required_status_checks?: Array<{
      context: string;
      integration_id?: number | null;
    }>;
    strict_required_status_checks_policy?: boolean | null;
  } | null;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status?: unknown }).status === 'number' &&
    (error as { status: number }).status === 404
  );
}

function dedupeChecks(checks: BranchRequiredCheck[]): BranchRequiredCheck[] {
  const seen = new Set<string>();
  const deduped: BranchRequiredCheck[] = [];

  for (const check of checks) {
    const key = `${check.context}\u0000${check.integrationId ?? -1}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(check);
  }

  return deduped.sort((a, b) => {
    if (a.context !== b.context) {
      return a.context.localeCompare(b.context);
    }

    return (a.integrationId ?? -1) - (b.integrationId ?? -1);
  });
}

async function fetchLegacyBranchProtectionRequiredChecks(
  owner: string,
  repo: string,
  branch: string
): Promise<BranchMergeRequirementSource | null> {
  try {
    const response = await getOctokit().request<{
      data: LegacyRequiredStatusChecksResponse;
    }>('GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks', {
      owner,
      repo,
      branch,
    });

    const data = response.data;
    const checks =
      data.checks && data.checks.length > 0
        ? data.checks.map((check) => ({
            context: check.context,
            integrationId: check.app_id ?? null,
          }))
        : (data.contexts ?? []).map((context) => ({
            context,
            integrationId: null,
          }));

    if (checks.length === 0) {
      return null;
    }

    return {
      sourceKind: 'legacy_branch_protection',
      sourceId: 0,
      sourceName: null,
      strict: data.strict,
      checks: dedupeChecks(checks),
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

async function fetchRulesetRequiredChecks(
  owner: string,
  repo: string,
  branch: string
): Promise<BranchMergeRequirementSource[]> {
  const rules: RulesBranchRuleResponse[] = [];

  for (let page = 1; ; page += 1) {
    const response = await getOctokit().request<{ data: RulesBranchRuleResponse[] }>(
      'GET /repos/{owner}/{repo}/rules/branches/{branch}',
      {
        owner,
        repo,
        branch,
        per_page: 100,
        page,
      }
    );

    rules.push(...response.data);
    if (response.data.length < 100) {
      break;
    }
  }

  const grouped = new Map<number, BranchMergeRequirementSource>();

  for (const rule of rules) {
    if (rule.type !== 'required_status_checks' || !rule.parameters) {
      continue;
    }

    const sourceId = rule.ruleset_id ?? 0;
    const existing = grouped.get(sourceId) ?? {
      sourceKind: 'ruleset' as const,
      sourceId,
      sourceName: rule.ruleset_name ?? null,
      strict: rule.parameters.strict_required_status_checks_policy ?? null,
      checks: [],
    };

    existing.sourceName ??= rule.ruleset_name ?? null;
    if (existing.strict === null) {
      existing.strict = rule.parameters.strict_required_status_checks_policy ?? null;
    }

    existing.checks.push(
      ...(rule.parameters.required_status_checks ?? []).map((check) => ({
        context: check.context,
        integrationId: check.integration_id ?? null,
      }))
    );
    grouped.set(sourceId, existing);
  }

  return [...grouped.values()]
    .map((requirement) => ({
      ...requirement,
      checks: dedupeChecks(requirement.checks),
    }))
    .filter((requirement) => requirement.checks.length > 0)
    .sort((a, b) => a.sourceId - b.sourceId);
}

export async function fetchBranchMergeRequirements(
  owner: string,
  repo: string,
  branch: string
): Promise<BranchMergeRequirementsSnapshot> {
  const [legacyRequirement, rulesetRequirements] = await Promise.all([
    fetchLegacyBranchProtectionRequiredChecks(owner, repo, branch),
    fetchRulesetRequiredChecks(owner, repo, branch),
  ]);

  return {
    owner,
    repo,
    branchName: branch,
    requirements: [...(legacyRequirement ? [legacyRequirement] : []), ...rulesetRequirements],
  };
}
