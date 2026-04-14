import { getReviewOutputJsonSchema } from '../formatters/review_output_schema.js';

const REVIEW_CATEGORIES_SECTION = `### Critical Issue Categories
- Code Correctness (HIGH): logic bugs, race conditions, boundary errors, unsafe error handling.
- Security Vulnerabilities (HIGH): injection, traversal, unsafe secrets handling, missing validation.
- Testing Problems (HIGH): missing tests for edge cases/failures, tests that don't verify behavior.
- Project Violations (MEDIUM): broken conventions, architecture mismatches, wrong module boundaries.
- Performance Issues (MEDIUM): unnecessary heavy work, memory growth, avoidable expensive operations.`;

export interface PrReviewMetadata {
  prUrl: string;
  prNumber: number;
  title: string | null;
  author: string | null;
  baseBranch: string;
  headBranch: string;
  owner: string;
  repo: string;
}

interface ReviewGuidePromptOptions {
  metadata: PrReviewMetadata;
  guidePath: string;
  useJj: boolean;
  customInstructions?: string;
}

interface ReviewGuideIssuesFollowUpPromptOptions {
  guidePath: string;
  issuesPath: string;
}

interface StandaloneReviewIssuesPromptOptions {
  metadata: PrReviewMetadata;
  useJj: boolean;
  customInstructions?: string;
}

interface IssueCombinationPromptOptions {
  claudeIssues: unknown;
  codexIssues: unknown;
}

function getDiffInstructions(baseBranch: string, useJj: boolean): string {
  // Quote the branch name to avoid issues with special characters in command examples.
  // Use remote-tracking refs so the diff is always against the fetched remote state,
  // not a potentially stale or missing local branch.
  const quotedBranch = baseBranch.replace(/'/g, "'\\''");

  if (useJj) {
    return [
      `Repository is jj-based. Determine the merge-base diff yourself; do not ask for inline diffs.`,
      `Primary command: \`jj diff --from 'heads(::@ & ::${quotedBranch}@origin)'\``,
      `Use \`jj diff ... -s\` for file lists and \`jj diff ... <path>\` for file-specific analysis.`,
    ].join('\n');
  }

  return [
    `Repository is git-based. Determine the merge-base diff yourself; do not ask for inline diffs.`,
    `Use: \`git merge-base 'origin/${quotedBranch}' HEAD\` then \`git diff <merge-base>\``,
    `Use \`git diff <merge-base> --name-only\` for file lists and file-specific diffs for deep analysis.`,
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

export function buildReviewGuidePrompt(options: ReviewGuidePromptOptions): string {
  const { metadata, guidePath, useJj, customInstructions } = options;
  return `You are reviewing a pull request and must produce a complete review guide before issue extraction.

## PR Metadata
${formatPrMetadata(metadata)}

## Diff Discovery
${getDiffInstructions(metadata.baseBranch, useJj)}

## Required Workflow
1. Enumerate all changed files from the PR diff.
2. Group files into functional sections/subsections (core logic, data model, API, tests, docs, etc.).
3. Analyze each section with enough detail that a reviewer can walk the PR without opening every file.
4. Ensure every changed file and every changed line is covered in at least one section.
5. Each section must include the full unified diff for all files in that section, in a \`\`\`unified-diff code block, so the reviewer can read the changes inline without opening the files separately.
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

  return `You are performing a standalone PR code review and must return structured JSON issues only.

## PR Metadata
${formatPrMetadata(metadata)}

## Diff Discovery
${getDiffInstructions(metadata.baseBranch, useJj)}

${REVIEW_CATEGORIES_SECTION}

## Output Requirements
- Return valid JSON matching the schema below.
- Focus on concrete, actionable issues tied to changed code.
- Prefer fewer high-signal findings over speculative noise.
- Do not include plan/task context; this is PR-only review.

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

  return `Merge two PR review outputs into one final review result.

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
