import { describe, expect, test } from 'vitest';
import {
  buildIssueCombinationPrompt,
  buildReviewGuideIssuesFollowUpPrompt,
  buildReviewGuidePrompt,
  buildStandaloneReviewIssuesPrompt,
  COMBINATION_OUTPUT_SCHEMA,
  type PrReviewMetadata,
} from './review_pr_prompt.js';

const METADATA: PrReviewMetadata = {
  prUrl: 'https://github.com/acme/repo/pull/42',
  prNumber: 42,
  title: 'Improve PR review flow',
  author: 'alice',
  baseBranch: 'main',
  headBranch: 'feature/review-guide',
  owner: 'acme',
  repo: 'repo',
};

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
