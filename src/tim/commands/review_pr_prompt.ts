import { getReviewOutputJsonSchema } from '../formatters/review_output_schema.js';
import {
  buildReviewerCriticalIssuesGuidance,
  buildPrReviewScopeGuidance,
  buildReviewerPromptIntro,
} from '../executors/claude_code/agent_prompts.js';

const REVIEW_CATEGORIES_SECTION = `### Critical Issue Categories
- Code Correctness (HIGH): logic bugs, race conditions, boundary errors, unsafe error handling.
- Security Vulnerabilities (HIGH): injection, traversal, unsafe secrets handling, missing validation.
- Testing Problems (HIGH): missing tests for edge cases/failures, tests that don't verify behavior.
- Project Violations (MEDIUM): broken conventions, architecture mismatches, wrong module boundaries.
- Performance Issues (MEDIUM): unnecessary heavy work, memory growth, avoidable expensive operations.`;

export interface PrReviewMetadata {
  kind: 'pr';
  prUrl: string;
  prNumber: number;
  title: string | null;
  author: string | null;
  baseBranch: string;
  headBranch: string;
  owner: string;
  repo: string;
}

export interface PlanReviewMetadata {
  kind: 'plan';
  planId: number;
  planUuid: string;
  title: string;
  goal: string | null;
  details: string | null;
  tasks: Array<{ title: string; status?: string | null }>;
  parentChain: Array<{ planId: number; title: string }>;
  completedChildren: Array<{ planId: number; title: string }>;
  baseBranch: string;
  headRef: string;
}

export type ReviewSubjectMetadata = PrReviewMetadata | PlanReviewMetadata;

export interface ReviewGuideDiffReference {
  ref: string;
  filePath: string | null;
  oldRange: string | null;
  newRange: string | null;
  header: string | null;
  preview: string | null;
}

interface ReviewGuidePromptOptions {
  metadata: ReviewSubjectMetadata;
  guidePath: string;
  useJj: boolean;
  diffReferences?: ReviewGuideDiffReference[] | null;
  customInstructions?: string;
}

interface ReviewGuideIssuesFollowUpPromptOptions {
  guidePath: string;
  issuesPath: string;
}

interface StandaloneReviewIssuesPromptOptions {
  metadata: ReviewSubjectMetadata;
  useJj: boolean;
  customInstructions?: string;
}

interface IssueCombinationPromptOptions {
  subjectKind?: ReviewSubjectMetadata['kind'];
  claudeIssues: unknown;
  codexIssues: unknown;
}

function getDiffInstructions(metadata: ReviewSubjectMetadata, useJj: boolean): string {
  const baseBranch = metadata.baseBranch;
  // Quote the branch name to avoid issues with special characters in command examples.
  const quotedBranch = baseBranch.replace(/'/g, "'\\''");

  if (useJj) {
    const fromRevset =
      metadata.kind === 'pr'
        ? `heads(::@ & ::${quotedBranch}@origin)`
        : `heads(::@ & ::${quotedBranch})`;
    return [
      `Repository is jj-based. Determine the merge-base diff yourself; do not ask for inline diffs.`,
      `Primary command: \`jj diff --from '${fromRevset}'\``,
      `Use \`jj diff ... -s\` for file lists and \`jj diff ... <path>\` for file-specific analysis.`,
    ].join('\n');
  }

  const baseRef = metadata.kind === 'pr' ? `origin/${quotedBranch}` : quotedBranch;
  return [
    `Repository is git-based. Determine the merge-base diff yourself; do not ask for inline diffs.`,
    `Use: \`git merge-base '${baseRef}' HEAD\` then \`git diff <merge-base>\``,
    `Use \`git diff <merge-base> --name-only\` for file lists and file-specific diffs for deep analysis.`,
    `When you generate diffs for the review guide, copy the relevant sections of \`git diff\` output verbatim. Do not paraphrase, normalize, or reconstruct the diff hunks.`,
  ].join('\n');
}

function formatPrMetadata(metadata: PrReviewMetadata): string {
  return [
    `- PR URL: ${metadata.prUrl}`,
    `- PR Number: #${metadata.prNumber}`,
    `- Repository: ${metadata.owner}/${metadata.repo}`,
    `- Title: ${metadata.title ?? '(unknown)'}`,
    `- Author: ${metadata.author ?? '(unknown)'}`,
    `- Base Branch: ${metadata.baseBranch}`,
    `- Head Branch: ${metadata.headBranch}`,
  ].join('\n');
}

function formatPlanMetadata(metadata: PlanReviewMetadata): string {
  const tasks =
    metadata.tasks.length > 0
      ? metadata.tasks
          .map((task) => `  - ${task.title}${task.status ? ` [${task.status}]` : ''}`)
          .join('\n')
      : '  - (none listed)';
  const parentChain =
    metadata.parentChain.length > 0
      ? metadata.parentChain.map((plan) => `  - #${plan.planId}: ${plan.title}`).join('\n')
      : '  - (none)';
  const completedChildren =
    metadata.completedChildren.length > 0
      ? metadata.completedChildren.map((plan) => `  - #${plan.planId}: ${plan.title}`).join('\n')
      : '  - (none)';

  return [
    `- Plan ID: #${metadata.planId}`,
    `- Plan UUID: ${metadata.planUuid}`,
    `- Title: ${metadata.title}`,
    `- Goal: ${metadata.goal?.trim() || '(none)'}`,
    `- Details: ${metadata.details?.trim() || '(none)'}`,
    `- Base Branch: ${metadata.baseBranch}`,
    `- Head Ref: ${metadata.headRef}`,
    '- Tasks:',
    tasks,
    '- Parent Chain:',
    parentChain,
    '- Completed Children:',
    completedChildren,
  ].join('\n');
}

function formatSubjectMetadata(metadata: ReviewSubjectMetadata): string {
  return metadata.kind === 'pr' ? formatPrMetadata(metadata) : formatPlanMetadata(metadata);
}

function getSubjectNoun(metadata: ReviewSubjectMetadata): string {
  return metadata.kind === 'pr' ? 'pull request' : 'plan implementation';
}

function getSubjectMetadataHeading(metadata: ReviewSubjectMetadata): string {
  return metadata.kind === 'pr' ? 'PR Metadata' : 'Plan Metadata';
}

function getGuideWorkflowSubject(metadata: ReviewSubjectMetadata): string {
  return metadata.kind === 'pr' ? 'PR diff' : 'plan implementation diff';
}

function maybeCustomInstructions(customInstructions?: string): string {
  const trimmed = customInstructions?.trim();
  if (!trimmed) {
    return '';
  }

  return `\n## Custom Instructions\n${trimmed}\n`;
}

function renderSchema(): string {
  return JSON.stringify(getReviewOutputJsonSchema(), null, 2);
}

function toJson(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function renderDiffReferenceCatalog(diffReferences?: ReviewGuideDiffReference[] | null): string {
  if (!diffReferences || diffReferences.length === 0) {
    return '';
  }

  const lines = [
    '## Diff Reference Catalog',
    'Use these exact refs when inserting diff placeholders into the guide.',
    'Write placeholders as `<diff ref="..."/>`, or use 1-based inclusive line ranges like `<diff ref="..." start="4" end="10"/>`; do not invent new refs.',
    'The `start` and `end` attributes are optional. Use them only when splitting a diff so explanatory text can appear between line ranges.',
    'Never truncate or omit diff refs for readability or because a diff is long; include every ref needed for the complete changed code in the relevant guide section.',
    '',
  ];

  for (const entry of diffReferences) {
    const filePart = entry.filePath ?? '(unknown file)';
    const oldPart = entry.oldRange ? `old ${entry.oldRange}` : 'old n/a';
    const newPart = entry.newRange ? `new ${entry.newRange}` : 'new n/a';
    const headerPart = entry.header ? ` ${entry.header}` : '';
    const previewPart = entry.preview ? ` | ${entry.preview}` : '';
    lines.push(
      `- \`${entry.ref}\` -> ${filePart} (${oldPart}, ${newPart})${headerPart}${previewPart}`
    );
  }

  return `${lines.join('\n')}\n`;
}

export function buildReviewGuidePrompt(options: ReviewGuidePromptOptions): string {
  const { metadata, guidePath, useJj, diffReferences, customInstructions } = options;
  const hasDiffReferences = Boolean(diffReferences && diffReferences.length > 0);
  return `You are reviewing a ${getSubjectNoun(metadata)} and must produce a complete review guide before issue extraction.

## ${getSubjectMetadataHeading(metadata)}
${formatSubjectMetadata(metadata)}

## Diff Discovery
${getDiffInstructions(metadata, useJj)}

${renderDiffReferenceCatalog(diffReferences)}

## Required Workflow
1. Enumerate all changed files from the ${getGuideWorkflowSubject(metadata)}.
2. Group files into functional sections/subsections (core logic, data model, API, tests, docs, etc.).
3. Analyze each section with enough detail that a reviewer can walk the ${metadata.kind === 'pr' ? 'PR' : 'plan changes'} without opening every file.
4. Ensure every changed file and every changed line is covered in at least one section.
5. ${
    hasDiffReferences
      ? 'Each section must include all needed `<diff ref="..."/>` placeholders using refs from the catalog above. You may add optional `start` and `end` attributes for 1-based inclusive line ranges only to insert explanatory text between ranges of the same diff; the final guide still needs every line, and the system will add any omitted lines back near the closest referenced range. Do not write raw diff blocks yourself. The system will replace the placeholders with the exact canonical diff text after you finish. Never truncate or omit diff refs for readability, length, or brevity; long diffs must still be represented with all relevant diff refs so the final guide contains the complete changed code.'
      : 'Each section must include the full unified diff for all files in that section, in a ```unified-diff code block, copied verbatim from the relevant `git diff` output, so the reviewer can read the changes inline without opening the files separately. Never truncate or omit any part of a diff for readability, length, or brevity.'
  }
6. Include subsection commentary plus concrete line references for important changes.
7. Ignore comments that begin with \`AI:\` or \`AI_COMMENT_START\`.

${REVIEW_CATEGORIES_SECTION}

## Output File
Write the guide as markdown to:
\`${guidePath}\`

The guide must be structured with section headers and subsection headers, and must explicitly call out major-risk areas first.${maybeCustomInstructions(
    customInstructions
  )}`;
}

export function buildReviewGuideIssuesFollowUpPrompt(
  options: ReviewGuideIssuesFollowUpPromptOptions
): string {
  const schema = renderSchema();
  return `Using the guide you just wrote at \`${options.guidePath}\`, now produce structured review issues.

## Instructions
- Re-read the guide and the underlying diff context before writing issues.
- Focus on actionable correctness, security, testing, performance, and compliance findings.
- Output MUST be valid JSON matching the schema below.
- Write the JSON to: \`${options.issuesPath}\`
- Do not include markdown fences inside the JSON file.

## Required JSON Schema
\`\`\`json
${schema}
\`\`\`
`;
}

export function buildStandaloneReviewIssuesPrompt(
  options: StandaloneReviewIssuesPromptOptions
): string {
  const { metadata, useJj, customInstructions } = options;
  const schema = renderSchema();
  const scopeGuidance =
    metadata.kind === 'pr'
      ? `${buildPrReviewScopeGuidance()}\n`
      : 'Evaluate the implementation against the plan goal, details, task list, parent context, and completed child plans. Focus only on defects or meaningful review issues in the changed code.\n';
  const planContextInstruction =
    metadata.kind === 'pr'
      ? '- Do not include plan/task context; this is PR-only review.'
      : '- Use the plan/task context only to judge whether changed code correctly implements the requested plan.';

  return `${buildReviewerPromptIntro(false)}You are performing a standalone ${metadata.kind === 'pr' ? 'PR' : 'plan implementation'} code review and must return structured JSON issues only.
${scopeGuidance}

## ${getSubjectMetadataHeading(metadata)}
${formatSubjectMetadata(metadata)}

## Diff Discovery
${getDiffInstructions(metadata, useJj)}

${buildReviewerCriticalIssuesGuidance()}

## Output Requirements
- Return valid JSON matching the schema below.
- Focus on concrete, actionable issues tied to changed code.
- Prefer fewer high-signal findings over speculative noise.
${planContextInstruction}
- Do not provide a verdict; only return the JSON issues payload.
- Use the same severity bar as the reviewer prompt: only report genuine issues that would matter in review.

## Required JSON Schema
\`\`\`json
${schema}
\`\`\`${maybeCustomInstructions(customInstructions)}`;
}

/**
 * Schema for the combination step output. Extends ReviewOutputSchema with a
 * structured `source` field per issue. This is only used by the Haiku
 * combination step (not Codex), so optional fields are safe.
 */
export const COMBINATION_OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    issues: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          severity: { type: 'string' as const, enum: ['critical', 'major', 'minor', 'info'] },
          category: {
            type: 'string' as const,
            enum: ['security', 'performance', 'bug', 'style', 'compliance', 'testing', 'other'],
          },
          content: { type: 'string' as const },
          file: { type: ['string', 'null'] as const },
          line: { type: ['string', 'null'] as const },
          suggestion: { type: 'string' as const },
          source: {
            type: 'string' as const,
            enum: ['claude-code', 'codex-cli', 'combined'],
            description:
              'Attribution: claude-code if from Claude only, codex-cli if from Codex only, combined if merged from both.',
          },
        },
        required: ['severity', 'category', 'content', 'file', 'line', 'suggestion', 'source'],
      },
    },
    recommendations: { type: 'array' as const, items: { type: 'string' as const } },
    actionItems: { type: 'array' as const, items: { type: 'string' as const } },
  },
  required: ['issues', 'recommendations', 'actionItems'],
};

export function buildIssueCombinationPrompt(options: IssueCombinationPromptOptions): string {
  const schema = JSON.stringify(COMBINATION_OUTPUT_SCHEMA, null, 2);
  const claudeIssues = toJson(options.claudeIssues);
  const codexIssues = toJson(options.codexIssues);
  const subjectLabel = options.subjectKind === 'plan' ? 'plan implementation' : 'PR';

  return `Merge two ${subjectLabel} review outputs into one final review result.

## Goals
- Deduplicate semantically equivalent issues.
- Preserve best wording and strongest evidence for each merged issue.
- Set the \`source\` field on each output issue for attribution:
  - \`"claude-code"\` if the issue comes only from the Claude set.
  - \`"codex-cli"\` if the issue comes only from the Codex set.
  - \`"combined"\` if the issue was found by both and merged.
- Do NOT embed source attribution in the \`content\` field.
- Keep severity/category conservative and accurate when merging.
- Merge recommendations and action items, deduplicating as needed.
- Return valid JSON only.

## Claude Issues Input
\`\`\`json
${claudeIssues}
\`\`\`

## Codex Issues Input
\`\`\`json
${codexIssues}
\`\`\`

## Output Schema (required)
\`\`\`json
${schema}
\`\`\`
`;
}
