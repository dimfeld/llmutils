/**
 * @fileoverview Advisor-backed remediation planning for review feedback.
 *
 * Fixing review findings one at a time, literally as written, is how a review
 * loop burns its whole budget: each literal fix can move the defect one level up
 * or down instead of removing it. When the advisor is configured, the findings
 * from a full-scope review are handed to it first so it can read the codebase
 * and return one ordered remediation plan grounded in the real structure of the
 * system. The plan is advice; the caller still owns the decision and the work.
 */

import type { ReviewIssue } from '../formatters/review_formatter.js';
import type { TimConfig } from '../configSchema.js';
import { isBlockingSeverity } from '../review_severity.js';
import { resolveAdvisorConfiguration } from './advisor.js';
import { launchPreparedSubagent, prepareSubagentExecution } from './service.js';

/** Everything the advisor needs to turn a set of review findings into a plan. */
export interface RemediationPlanContext {
  readonly planId: number;
  readonly planTitle: string;
  readonly issues: readonly ReviewIssue[];
  /** Human-readable scope of the review that produced these findings. */
  readonly reviewScope: string;
  /** Reviewer recommendations, when the review produced any. */
  readonly recommendations?: readonly string[];
  /** Reviewer action items, when the review produced any. */
  readonly actionItems?: readonly string[];
}

export interface RemediationPlanRequest extends RemediationPlanContext {
  readonly configPath?: string;
  readonly repositoryRoot?: string;
}

export interface RemediationPlanResult {
  readonly remediationPlan: string;
  readonly executor: string;
}

/**
 * Whether the review command should ask the advisor for a remediation plan.
 *
 * The advisor itself is opt-in, so its presence is the main gate. An explicit
 * CLI flag wins over config, and config over the default of "on whenever the
 * advisor exists", because a project that configured an advisor asked for its
 * judgment on exactly this kind of problem.
 *
 * Without an explicit `--remediation-plan`, at least one blocking finding is
 * required. A review that found only `minor` and `info` polish does not send the
 * orchestrator around the fix-and-re-review loop, which is the cost this
 * consultation exists to avoid.
 */
export function shouldGenerateRemediationPlan(params: {
  config: TimConfig | undefined;
  /** `--remediation-plan` / `--no-remediation-plan`, when either was passed. */
  cliOverride?: boolean;
  /** False for task-scoped reviews; remediation planning is a full-scope activity. */
  isFullScopeReview: boolean;
  issues: readonly ReviewIssue[];
}): boolean {
  if (params.cliOverride === false) {
    return false;
  }
  if (!params.isFullScopeReview || params.issues.length === 0) {
    return false;
  }
  if (!resolveAdvisorConfiguration(params.config)) {
    return false;
  }
  if (params.cliOverride === true) {
    return true;
  }
  if (params.config?.review?.remediationPlan === false) {
    return false;
  }
  return params.issues.some((issue) => isBlockingSeverity(issue.severity));
}

function formatIssueForRemediation(issue: ReviewIssue, index: number): string {
  const location = issue.file
    ? issue.line != null
      ? `${issue.file}:${issue.line}`
      : issue.file
    : 'No file specified';
  const lines = [
    `${index}. [${issue.severity.toUpperCase()}] ${issue.category}`,
    `   Location: ${location}`,
    `   Finding: ${issue.content.trim()}`,
  ];
  if (issue.suggestion?.trim()) {
    lines.push(`   Reviewer suggestion: ${issue.suggestion.trim()}`);
  }
  return lines.join('\n');
}

/**
 * Builds the consultation text sent to the advisor as its `--input`.
 *
 * The findings are restated in full rather than referenced by index, because the
 * advisor runs as a separate process with no access to the reviewer's output
 * file.
 */
export function buildRemediationPlanInput(context: RemediationPlanContext): string {
  const sections: string[] = [
    `# Remediation Planning Request`,
    ``,
    `A code review of plan ${context.planId} (${context.planTitle}) reported the findings below.`,
    `Review scope: ${context.reviewScope}`,
    ``,
    `Your job is NOT to answer a design question this time. It is to turn these findings into a single, ordered remediation plan that an implementer can execute.`,
    ``,
    `## Review Findings`,
    ``,
    ...context.issues.flatMap((issue, index) => [formatIssueForRemediation(issue, index + 1), ``]),
  ];

  const recommendations = context.recommendations?.filter((entry) => entry.trim()) ?? [];
  if (recommendations.length > 0) {
    sections.push(
      `## Reviewer Recommendations`,
      ``,
      ...recommendations.map((entry) => `- ${entry}`),
      ``
    );
  }

  const actionItems = context.actionItems?.filter((entry) => entry.trim()) ?? [];
  if (actionItems.length > 0) {
    sections.push(`## Reviewer Action Items`, ``, ...actionItems.map((entry) => `- ${entry}`), ``);
  }

  sections.push(
    `## What To Produce`,
    ``,
    `Read the affected code before deciding anything. Reviewers see a diff; you can see the whole system, so judge each finding against how the code actually works.`,
    ``,
    `1. **Root causes** — group the findings by the underlying defect. Several findings often share one cause: a broken invariant, a duplicated responsibility, a wrong ownership boundary, or a missing abstraction. Name the cause, and list which findings it explains.`,
    `2. **Correct fix per root cause** — the fix that removes the cause. A literal patch at the reported line is often wrong: it can push the defect one level up or down and produce another finding in the next review round. Say explicitly when the right fix is at a different layer, in a different file, or in a caller rather than the reported location, and say what would go wrong with the literal fix.`,
    `3. **Ordered remediation steps** — a numbered sequence an implementer can follow. For each step give the files to change, what the change is, why it is in this position in the order, and how to verify it. Order steps so that shared or structural work happens before the per-site work that depends on it, and call out steps that must not be split across separate agents.`,
    `4. **Findings to reject or defer** — findings that are wrong, already handled, or not worth fixing now. Give concrete evidence from the code for each rejection, and state whether it is a rejection or a non-blocking deferral.`,
    `5. **Verification** — the checks, tests, and commands that prove the remediation worked, plus any new test worth adding to keep the root cause from returning.`,
    `6. **Risks** — what could break, what you could not verify, and what the implementer should watch for.`,
    ``,
    `Be specific and concrete: real file paths, real symbols, real commands. Do not restate the findings without analysis, and do not produce a plan that is just "fix finding 1, fix finding 2, ...". If the findings genuinely are independent, one-line fixes, say so plainly and keep the plan short.`
  );

  return sections.join('\n');
}

/**
 * Runs the advisor over review feedback and returns its remediation plan.
 *
 * Throws when the advisor is not configured; call `shouldGenerateRemediationPlan()`
 * first. Provider failures propagate so the caller can decide whether a failed
 * consultation is fatal — for the review command it is not.
 */
export async function generateRemediationPlan(
  request: RemediationPlanRequest
): Promise<RemediationPlanResult> {
  const prepared = await prepareSubagentExecution({
    agentType: 'advisor',
    planId: request.planId,
    configPath: request.configPath,
    repositoryRoot: request.repositoryRoot,
    inputPolicy: { type: 'resolved', initialMessage: buildRemediationPlanInput(request) },
  });

  const { completion, executor } = launchPreparedSubagent(prepared);
  const result = await completion;
  return { remediationPlan: result.finalMessage.trim(), executor };
}
