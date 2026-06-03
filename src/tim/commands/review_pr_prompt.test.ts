import { describe, expect, test } from 'vitest';
import {
  buildIssueCombinationPrompt,
  buildReviewGuideCommentPrompt,
  buildReviewGuideIssuesFollowUpPrompt,
  buildReviewGuidePrompt,
  buildStandaloneReviewIssuesPrompt,
  COMBINATION_OUTPUT_SCHEMA,
  type PrReviewMetadata,
  type PlanReviewMetadata,
  type ReviewGuideDiffReference,
} from './review_pr_prompt.js';

const METADATA: PrReviewMetadata = {
  kind: 'pr',
  prUrl: 'https://github.com/acme/repo/pull/42',
  prNumber: 42,
  title: 'Improve PR review flow',
  author: 'alice',
  baseBranch: 'main',
  headBranch: 'feature/review-guide',
  owner: 'acme',
  repo: 'repo',
};

const PLAN_METADATA: PlanReviewMetadata = {
  kind: 'plan',
  planId: 348,
  planUuid: 'plan-uuid-348',
  title: 'Plan-only review guides',
  goal: 'Generate review guides without a GitHub PR.',
  details: 'Reuse the PR review-guide pipeline for plan-only work.',
  tasks: [
    { title: 'Parameterize prompts', status: 'done' },
    { title: 'Extract workflow', status: 'in_progress' },
  ],
  parentChain: [{ planId: 347, title: 'Support plan review guides' }],
  completedChildren: [{ planId: 346, title: 'Review storage groundwork' }],
  baseBranch: 'main',
  headRef: 'HEAD',
};

const DIFF_REFERENCES: ReviewGuideDiffReference[] = [
  {
    ref: 'src/tim/commands/review_pr.ts#hunk-1',
    filePath: 'src/tim/commands/review_pr.ts',
    oldRange: '100-110',
    newRange: '100-115',
    header: '@@ -100,11 +100,16 @@',
    preview: '-old behavior | +new behavior',
  },
];

describe('review_pr_prompt', () => {
  test('buildReviewGuidePrompt includes metadata and git instructions', () => {
    const prompt = buildReviewGuidePrompt({
      metadata: METADATA,
      guidePath: '.tim/tmp/review-guide.md',
      useJj: false,
    });

    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain(METADATA.prUrl);
    expect(prompt).toContain(METADATA.title!);
    expect(prompt).toContain("git merge-base 'origin/main' HEAD");
    expect(prompt).toContain('.tim/tmp/review-guide.md');
    expect(prompt).toContain('Group files into functional sections');
    expect(prompt).toContain('copied verbatim from the relevant `git diff` output');
    expect(prompt).toContain('Never truncate or omit any part of a diff');
  });

  test('buildReviewGuideCommentPrompt produces a concise, comment-oriented prompt', () => {
    const prompt = buildReviewGuideCommentPrompt({
      metadata: METADATA,
      outputPath: '/work/.tim/tmp/pr-review-guide-comment-42.md',
      useJj: false,
    });

    expect(prompt).toContain('posted as a comment on a GitHub pull request');
    expect(prompt).toContain(METADATA.prUrl);
    expect(prompt).toContain("git merge-base 'origin/main' HEAD");
    expect(prompt).toContain('Pay special attention to');
    expect(prompt).toContain('Group the changes into a small number of logical sections');
    expect(prompt).toContain('Do not paste diffs or large code blocks');
    expect(prompt).toContain('Non-test change stats');
    expect(prompt).toContain(
      "jj diff --stat \\\n  -f 'latest(heads(bookmarks() & ancestors(@--)) | fork_point(@ | main), 1)'"
    );
    expect(prompt).toContain('glob:"**/*.spec.*"');
    expect(prompt).toContain('glob:"**/*.test.*"');
    expect(prompt).toContain('place the detailed file list inside a `<details>` block');
    expect(prompt).toContain('/work/.tim/tmp/pr-review-guide-comment-42.md');
  });

  test('buildReviewGuideCommentPrompt uses jj diff instructions when requested', () => {
    const prompt = buildReviewGuideCommentPrompt({
      metadata: METADATA,
      outputPath: '/work/.tim/tmp/pr-review-guide-comment-42.md',
      useJj: true,
    });

    expect(prompt).toContain('Repository is jj-based');
    expect(prompt).toContain('jj diff');
  });

  test('buildReviewGuidePrompt includes diff placeholder instructions when refs are provided', () => {
    const prompt = buildReviewGuidePrompt({
      metadata: METADATA,
      guidePath: '.tim/tmp/review-guide.md',
      useJj: false,
      diffReferences: DIFF_REFERENCES,
    });

    expect(prompt).toContain('## Diff Reference Catalog');
    expect(prompt).toContain(DIFF_REFERENCES[0].ref);
    expect(prompt).toContain('Write placeholders as `<diff ref="..."/>`');
    expect(prompt).toContain('<diff ref="..." start="4" end="10"/>');
    expect(prompt).toContain('Use them only when splitting a diff');
    expect(prompt).toContain('Do not write raw diff blocks yourself');
    expect(prompt).toContain('Never truncate or omit diff refs for readability');
    expect(prompt).toContain('long diffs must still be represented with all relevant diff refs');
    expect(prompt).toContain(
      'the system will add any omitted lines back near the closest referenced range'
    );
  });

  test('buildReviewGuidePrompt includes jj instructions when requested', () => {
    const prompt = buildReviewGuidePrompt({
      metadata: METADATA,
      guidePath: '.tim/tmp/review-guide.md',
      useJj: true,
    });

    expect(prompt).toContain("jj diff --from 'heads(::@ & ::main@origin)'");
    expect(prompt).not.toContain('git merge-base');
  });

  test('buildReviewGuideIssuesFollowUpPrompt includes guide path, issues path, and schema', () => {
    const prompt = buildReviewGuideIssuesFollowUpPrompt({
      guidePath: '.tim/tmp/review-guide.md',
      issuesPath: '.tim/tmp/review-issues.json',
    });

    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('.tim/tmp/review-guide.md');
    expect(prompt).toContain('.tim/tmp/review-issues.json');
    expect(prompt).toContain('"properties"');
    expect(prompt).toContain('"issues"');
  });

  test('buildStandaloneReviewIssuesPrompt includes categories without plan context', () => {
    const prompt = buildStandaloneReviewIssuesPrompt({
      metadata: METADATA,
      useJj: false,
    });

    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('You are a tim critical code reviewer');
    expect(prompt).toContain('Do not be polite or encouraging');
    expect(prompt).toContain('## Critical Issues to Flag');
    expect(prompt).toContain('Code Correctness (HIGH PRIORITY)');
    expect(prompt).toContain('Security Vulnerabilities (HIGH PRIORITY)');
    expect(prompt).toContain('Do not include plan/task context');
    expect(prompt).toContain('Do not provide a verdict');
    expect(prompt).toContain('For PR reviews, also check for outdated documentation');
    expect(prompt).toContain('Do not run tests, type checking, linting, formatting');
    expect(prompt).not.toContain('## Review Scope');
    expect(prompt).toContain('"issues"');
  });

  test('buildStandaloneReviewIssuesPrompt includes jj commands when useJj is true', () => {
    const prompt = buildStandaloneReviewIssuesPrompt({
      metadata: METADATA,
      useJj: true,
    });

    expect(prompt).toContain("jj diff --from 'heads(::@ & ::main@origin)'");
    expect(prompt).toContain('Repository is jj-based');
  });

  test('buildIssueCombinationPrompt includes both issue sets and merge instructions', () => {
    const claude = { issues: [{ severity: 'major', category: 'bug', content: 'A', file: 'a.ts' }] };
    const codex = {
      issues: [{ severity: 'minor', category: 'style', content: 'B', file: 'b.ts' }],
    };
    const prompt = buildIssueCombinationPrompt({
      claudeIssues: claude,
      codexIssues: codex,
    });

    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('"content": "A"');
    expect(prompt).toContain('"content": "B"');
    expect(prompt).toContain('Deduplicate semantically equivalent issues');
    expect(prompt).toContain('"issues"');
  });

  test('buildIssueCombinationPrompt uses plan framing for plan reviews', () => {
    const prompt = buildIssueCombinationPrompt({
      subjectKind: 'plan',
      claudeIssues: { issues: [] },
      codexIssues: { issues: [] },
    });

    expect(prompt).toContain('Merge two plan implementation review outputs');
    expect(prompt).not.toContain('Merge two PR review outputs');
  });

  test('custom instructions are included when provided', () => {
    const guidePrompt = buildReviewGuidePrompt({
      metadata: METADATA,
      guidePath: '.tim/tmp/review-guide.md',
      useJj: false,
      customInstructions: 'Prioritize API breaking changes.',
    });
    const issuesPrompt = buildStandaloneReviewIssuesPrompt({
      metadata: METADATA,
      useJj: false,
      customInstructions: 'Be strict about validation regressions.',
    });

    expect(guidePrompt).toContain('Prioritize API breaking changes.');
    expect(issuesPrompt).toContain('Be strict about validation regressions.');
  });

  test('custom instructions are omitted when not provided', () => {
    const guidePrompt = buildReviewGuidePrompt({
      metadata: METADATA,
      guidePath: '.tim/tmp/review-guide.md',
      useJj: false,
    });
    const issuesPrompt = buildStandaloneReviewIssuesPrompt({
      metadata: METADATA,
      useJj: false,
    });

    expect(guidePrompt).not.toContain('## Custom Instructions');
    expect(issuesPrompt).not.toContain('## Custom Instructions');
  });

  test('custom instructions are omitted when empty string is provided', () => {
    const guidePrompt = buildReviewGuidePrompt({
      metadata: METADATA,
      guidePath: '.tim/tmp/review-guide.md',
      useJj: false,
      customInstructions: '   ',
    });
    const issuesPrompt = buildStandaloneReviewIssuesPrompt({
      metadata: METADATA,
      useJj: false,
      customInstructions: '',
    });

    expect(guidePrompt).not.toContain('## Custom Instructions');
    expect(issuesPrompt).not.toContain('## Custom Instructions');
  });

  test('buildReviewGuidePrompt includes all PR metadata fields', () => {
    const prompt = buildReviewGuidePrompt({
      metadata: METADATA,
      guidePath: '.tim/tmp/review-guide.md',
      useJj: false,
    });

    expect(prompt).toContain('acme/repo');
    expect(prompt).toContain('#42');
    expect(prompt).toContain('alice');
    expect(prompt).toContain('feature/review-guide');
    expect(prompt).toContain('main');
  });

  test('buildReviewGuidePrompt includes plan metadata and plan framing', () => {
    const prompt = buildReviewGuidePrompt({
      metadata: PLAN_METADATA,
      guidePath: '.tim/tmp/review-guide.md',
      useJj: false,
    });

    expect(prompt).toContain('reviewing a plan implementation');
    expect(prompt).toContain('## Plan Metadata');
    expect(prompt).toContain('Plan ID: #348');
    expect(prompt).toContain('Plan UUID: plan-uuid-348');
    expect(prompt).toContain('Goal: Generate review guides without a GitHub PR.');
    expect(prompt).toContain('Parameterize prompts [done]');
    expect(prompt).toContain('#347: Support plan review guides');
    expect(prompt).toContain('#346: Review storage groundwork');
    expect(prompt).toContain('plan implementation diff');
    expect(prompt).toContain("git merge-base 'main' HEAD");
    expect(prompt).not.toContain('origin/');
    expect(prompt).not.toContain('## PR Metadata');
    expect(prompt).not.toContain('PR URL:');
  });

  test('buildReviewGuidePrompt uses local jj revset for plan metadata', () => {
    const prompt = buildReviewGuidePrompt({
      metadata: PLAN_METADATA,
      guidePath: '.tim/tmp/review-guide.md',
      useJj: true,
    });

    expect(prompt).toContain("jj diff --from 'heads(::@ & ::main)'");
    expect(prompt).not.toContain('@origin');
  });

  test('buildReviewGuidePrompt renders (unknown) when title and author are null', () => {
    const metaNulls: PrReviewMetadata = {
      ...METADATA,
      title: null,
      author: null,
    };
    const prompt = buildReviewGuidePrompt({
      metadata: metaNulls,
      guidePath: '.tim/tmp/guide.md',
      useJj: false,
    });

    expect(prompt).toContain('(unknown)');
  });

  test('buildStandaloneReviewIssuesPrompt includes PR metadata', () => {
    const prompt = buildStandaloneReviewIssuesPrompt({
      metadata: METADATA,
      useJj: false,
    });

    expect(prompt).toContain(METADATA.prUrl);
    expect(prompt).toContain(METADATA.title!);
    expect(prompt).toContain(METADATA.author!);
    expect(prompt).toContain('main');
  });

  test('buildStandaloneReviewIssuesPrompt includes plan context', () => {
    const prompt = buildStandaloneReviewIssuesPrompt({
      metadata: PLAN_METADATA,
      useJj: false,
    });

    expect(prompt).toContain('standalone plan implementation code review');
    expect(prompt).toContain('## Plan Metadata');
    expect(prompt).toContain('Use the plan/task context');
    expect(prompt).toContain('Plan-only review guides');
    expect(prompt).toContain("git merge-base 'main' HEAD");
    expect(prompt).not.toContain('origin/');
    expect(prompt).not.toContain('@origin');
    expect(prompt).not.toContain('Do not include plan/task context; this is PR-only review.');
  });

  test('buildStandaloneReviewIssuesPrompt uses local jj revset for plan metadata', () => {
    const prompt = buildStandaloneReviewIssuesPrompt({
      metadata: PLAN_METADATA,
      useJj: true,
    });

    expect(prompt).toContain("jj diff --from 'heads(::@ & ::main)'");
    expect(prompt).not.toContain('origin/');
    expect(prompt).not.toContain('@origin');
  });

  test('buildIssueCombinationPrompt handles string inputs directly', () => {
    const claudeRaw = '{"issues": [], "recommendations": [], "actionItems": []}';
    const codexRaw =
      '{"issues": [{"severity": "minor", "category": "style", "content": "C", "file": "c.ts", "line": "1", "suggestion": "fix it"}], "recommendations": [], "actionItems": []}';

    const prompt = buildIssueCombinationPrompt({
      claudeIssues: claudeRaw,
      codexIssues: codexRaw,
    });

    // When input is a string, it should be used verbatim, not double-JSON-encoded
    expect(prompt).toContain(claudeRaw);
    expect(prompt).toContain(codexRaw);
    expect(prompt).toContain('"content": "C"');
  });

  test('buildIssueCombinationPrompt uses structured source field, not content markers', () => {
    const prompt = buildIssueCombinationPrompt({
      claudeIssues: { issues: [] },
      codexIssues: { issues: [] },
    });

    // Should instruct using the structured source field
    expect(prompt).toContain('"claude-code"');
    expect(prompt).toContain('"codex-cli"');
    expect(prompt).toContain('"combined"');
    expect(prompt).toContain('"source"');
    // Should NOT embed source markers in content
    expect(prompt).toContain('Do NOT embed source attribution in the `content` field');
  });

  test('COMBINATION_OUTPUT_SCHEMA allows null for file and line', () => {
    const issueProps = COMBINATION_OUTPUT_SCHEMA.properties.issues.items.properties;
    expect(issueProps.file.type).toContain('null');
    expect(issueProps.line.type).toContain('null');
    expect(issueProps.file.type).toContain('string');
    expect(issueProps.line.type).toContain('string');
  });
});
