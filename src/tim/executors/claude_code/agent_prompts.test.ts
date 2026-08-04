import { describe, it, expect, vi } from 'vitest';
import {
  getImplementerPrompt,
  getTddTestsPrompt,
  getTesterPrompt,
  getReviewerPrompt,
  getPrDescriptionPrompt,
  buildReviewerSimplificationGuidance,
  buildReviewerCriticalIssuesGuidance,
  FAILED_PROTOCOL_INSTRUCTIONS,
} from './agent_prompts.ts';
import { REVIEW_DUPLICATION_GUIDANCE, REVIEW_SEVERITY_GUIDANCE } from '../../review_severity.js';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('agent_prompts failure protocol integration', () => {
  const context = 'Context and Task...';

  it('includes FAILED protocol in implementer prompt', () => {
    const def = getImplementerPrompt(context);
    expect(def.prompt).toContain('FAILED:');
    expect(def.prompt).toContain('Failure Protocol');
    expect(def.prompt).toContain('It is okay to fix pre-existing errors');
    expect(def.prompt).toContain('not a failure condition by itself');
    expect(def.prompt).toContain('fix it, verify the fix, and continue');
    // Sanity check a snippet from the shared template
    expect(FAILED_PROTOCOL_INSTRUCTIONS).toContain('Possible solutions');
    expect(def.prompt).toContain('Possible solutions');
  });

  it('includes FAILED protocol in tester prompt', () => {
    const def = getTesterPrompt(context);
    expect(def.prompt).toContain('FAILED:');
    expect(def.prompt).toContain('Failure Protocol');
  });

  it('includes TDD-first guidance in tdd-tests prompt', () => {
    const def = getTddTestsPrompt(context);
    expect(def.prompt).toContain('TDD test-writing agent');
    expect(def.prompt).toContain('tests should initially FAIL');
    expect(def.prompt).toContain('verify they fail for the correct reasons');
    expect(def.prompt).toContain('Progress Reporting');
  });

  it('includes commit scope guidance in committing subagent prompts', () => {
    const expectedText = 'always include any unexpected modified files in the commit';
    expect(getImplementerPrompt(context).prompt).toContain(expectedText);
    expect(getTesterPrompt(context).prompt).toContain(expectedText);
    expect(getTddTestsPrompt(context).prompt).toContain(expectedText);
  });

  it('omits jj version-control guidance when useJj is not set', () => {
    expect(getImplementerPrompt(context).prompt).not.toContain('Use Jujutsu (jj), not git');
    expect(getTesterPrompt(context).prompt).not.toContain('Use Jujutsu (jj), not git');
    expect(getTesterPrompt(context).prompt).not.toContain('`jj status`');
  });

  it('adds jj version-control guidance to committing subagents when useJj is true', () => {
    const jjMarker = 'Use Jujutsu (jj), not git';
    expect(
      getImplementerPrompt(context, undefined, undefined, undefined, { useJj: true }).prompt
    ).toContain(jjMarker);
    expect(
      getTesterPrompt(context, undefined, undefined, undefined, { useJj: true }).prompt
    ).toContain(jjMarker);
    expect(
      getTddTestsPrompt(context, undefined, undefined, undefined, { useJj: true }).prompt
    ).toContain(jjMarker);

    const tester = getTesterPrompt(context, undefined, undefined, undefined, {
      useJj: true,
    }).prompt;
    expect(tester).toContain(jjMarker);
    expect(tester).toContain('Do NOT run `git` commands');
  });

  it('includes FAILED protocol in reviewer prompt', () => {
    const def = getReviewerPrompt(context);
    expect(def.prompt).toContain('FAILED:');
    expect(def.prompt).toContain('Failure Protocol');
  });

  it('keeps requirements mismatches blocking while calibrating them by impact', () => {
    const def = getReviewerPrompt(context);
    expect(def.prompt).toContain(
      'Functionality that is implemented but does not meet requirements is always blocking, even if it appears to work.'
    );
    expect(def.prompt).toContain(
      'Label such a mismatch `critical` when the change is broken or dangerous as-is, and `major` otherwise. Never label a requirements mismatch `minor` or `info`.'
    );
    expect(def.prompt).not.toContain(
      'implemented but does not meet requirements is a CRITICAL issue'
    );
  });

  it('includes the severity rubric and repeated-defect reporting guidance', () => {
    const def = getReviewerPrompt(context);

    expect(def.prompt).toContain(
      '- `critical` — the change is broken or dangerous as-is: data loss, a security vulnerability, a crash, or silently wrong results on mainline paths. This is blocking.'
    );
    expect(def.prompt).toContain(
      '- `major` — a real correctness, regression, or missing-coverage problem that must be fixed before the work is done; a reviewer would block a merge on it. This is blocking.'
    );
    expect(def.prompt).toContain(
      '- `minor` — a genuine improvement that does not block: naming, small refactors, non-mainline edge polish, or better error messages. This is non-blocking.'
    );
    expect(def.prompt).toContain(
      '- `info` — observations, style, wording, and anything pre-existing. This is non-blocking.'
    );
    expect(def.prompt).toContain('Do not inflate style or preference findings to `major`.');
    expect(def.prompt).toContain(
      'Do not downgrade correctness problems to `minor` because the fix is small.'
    );
    expect(def.prompt).toContain('Fix effort is not part of severity; only impact is.');
    expect(def.prompt).toContain(
      'When the same defect class appears at multiple locations, report it as ONE finding rather than N separate findings.'
    );
    expect(def.prompt).toContain('this pattern appears at: <file:line list>');
    expect(def.prompt).toContain('State the shared root cause');
    expect(def.prompt).toContain(
      'Set `file` and `line` to the primary instance; the other locations belong in the issue `content`.'
    );
  });

  it('buildReviewerCriticalIssuesGuidance includes the rubric and duplication guidance by default', () => {
    const guidance = buildReviewerCriticalIssuesGuidance();

    expect(guidance).toContain(REVIEW_SEVERITY_GUIDANCE);
    expect(guidance).toContain(REVIEW_DUPLICATION_GUIDANCE);
    expect(guidance).toContain('## Critical Issues to Flag:');
  });

  it('buildReviewerCriticalIssuesGuidance always owns the rubric and duplication guidance', () => {
    const guidance = buildReviewerCriticalIssuesGuidance();

    expect(countOccurrences(guidance, REVIEW_SEVERITY_GUIDANCE)).toBe(1);
    expect(countOccurrences(guidance, REVIEW_DUPLICATION_GUIDANCE)).toBe(1);
    expect(guidance).toContain('## Critical Issues to Flag:');
  });

  it('keeps reviewer-owned guidance independent of contextContent', () => {
    const contextWithRubric = `${context}\n\n${REVIEW_SEVERITY_GUIDANCE}\n\n${REVIEW_DUPLICATION_GUIDANCE}`;
    const def = getReviewerPrompt(contextWithRubric);

    expect(countOccurrences(def.prompt, REVIEW_SEVERITY_GUIDANCE)).toBe(2);
    expect(countOccurrences(def.prompt, REVIEW_DUPLICATION_GUIDANCE)).toBe(2);
  });

  it('getReviewerPrompt includes the rubric exactly once when contextContent lacks it', () => {
    const def = getReviewerPrompt(context);

    expect(countOccurrences(def.prompt, REVIEW_SEVERITY_GUIDANCE)).toBe(1);
    expect(countOccurrences(def.prompt, REVIEW_DUPLICATION_GUIDANCE)).toBe(1);
  });

  it('keeps legacy free-text severity examples aligned with the rubric', () => {
    const def = getReviewerPrompt(context);

    expect(def.prompt).toContain(
      'CRITICAL: [The change is broken or dangerous as-is: data loss, a security vulnerability, a crash, or silently wrong results on mainline paths]'
    );
    expect(def.prompt).toContain(
      'MAJOR: [A real correctness, regression, or missing-coverage problem that must be fixed before the work is done; a reviewer would block a merge on it]'
    );
    expect(def.prompt).toContain(
      'MINOR: [A genuine improvement that does not block: naming, small refactors, non-mainline edge polish, or better error messages]'
    );
  });

  it('requires project-root-relative file paths in reviewer findings', () => {
    const def = getReviewerPrompt(context);
    expect(def.prompt).toContain(
      'When you reference files in your findings, use file paths relative to the project root. Do not use absolute paths.'
    );
  });

  it('tells reviewers not to mutate the shared workspace while testing', () => {
    const def = getReviewerPrompt(context);
    expect(def.prompt).toContain('Other reviewers may be examining the same workspace in parallel');
    expect(def.prompt).toContain(
      'Do not mutate code in the current workspace to test a hypothesis'
    );
  });

  it('includes dead code guidance in reviewer prompt', () => {
    const def = getReviewerPrompt(context);
    expect(def.prompt).toContain(
      'Newly dead code or unreachable code paths that should be removed'
    );
  });

  it('does not include structural simplification guidance in the normal reviewer prompt', () => {
    const def = getReviewerPrompt(context);
    expect(def.prompt).not.toContain('Simplification Review');
    expect(def.prompt).not.toContain('No artificial finding cap');
    expect(def.prompt).not.toContain('Report every high-conviction structural issue');
  });

  it('defines structural maintainability guidance for standalone simplification reviews', () => {
    const guidance = buildReviewerSimplificationGuidance();
    expect(guidance).toContain('Simplification Review');
    expect(guidance).toContain(
      'preserve behavior while making the implementation dramatically simpler'
    );
    expect(guidance).toContain('push a file from under 1,000 lines');
    expect(guidance).toContain(
      '"Consider refactoring" or "this could be cleaner" is NOT a suggestion'
    );
    expect(guidance).toContain('No artificial finding cap');
    expect(guidance).toContain('Report every high-conviction structural issue');
    expect(guidance).not.toContain('Aim for at most 8-10 findings');
  });

  it('tells reviewers not to over-abstract test code', () => {
    const guidance = buildReviewerSimplificationGuidance();
    expect(guidance).toContain('Test code is different');
    expect(guidance).toContain('Repetition in tests is usually fine');
    expect(guidance).toContain('Do NOT flag near-identical tests merely because they repeat setup');
  });

  it('does not encourage reviewer prompts to stop after a small sample of findings', () => {
    const def = getReviewerPrompt(context);
    expect(def.prompt).toContain('Report every high-confidence actionable issue');
    expect(def.prompt).toContain('Do not stop after a small sample of findings');
  });

  it('can include PR review scope guidance in reviewer prompt when requested', () => {
    const def = getReviewerPrompt(
      context,
      undefined,
      undefined,
      undefined,
      false,
      false,
      undefined,
      true
    );
    expect(def.prompt).toContain('For PR reviews, also check for outdated documentation');
    expect(def.prompt).toContain('Do not run tests, type checking, linting, formatting');
  });

  it('omits PR review scope guidance by default', () => {
    const def = getReviewerPrompt(context);
    expect(def.prompt).not.toContain('For PR reviews, also check for outdated documentation');
  });

  it('directs implementer to report progress to orchestrator', () => {
    const def = getImplementerPrompt(context, '42');
    expect(def.prompt).toContain('Progress Reporting');
    expect(def.prompt).toContain('Do NOT update the plan file directly');
    expect(def.prompt).not.toContain('Progress Updates (Plan File)');
  });

  it('uses progress section update guidance when requested', () => {
    const def = getTesterPrompt(context, '152', undefined, undefined, {
      mode: 'update',
      planFilePath: '/plans/152.plan.md',
    });
    expect(def.prompt).toContain('Progress Updates (Plan File)');
    expect(def.prompt).toContain('@/plans/152.plan.md');
    expect(def.prompt).not.toContain('Progress Reporting');
  });

  it('supports progress update guidance without @ prefix', () => {
    const def = getTesterPrompt(context, '152', undefined, undefined, {
      mode: 'update',
      planFilePath: '/plans/152.plan.md',
      useAtPrefix: false,
    });
    expect(def.prompt).toContain('Progress Updates (Plan File)');
    expect(def.prompt).toContain('Update the plan file at: /plans/152.plan.md');
    expect(def.prompt).not.toContain('@/plans/152.plan.md');
  });

  it('adds subagent directive to reviewer prompt when enabled', () => {
    const def = getReviewerPrompt(context, undefined, undefined, undefined, true);
    expect(def.prompt).toContain('Use the available sub-agents');
  });

  it('omits subagent directive from reviewer prompt when disabled', () => {
    const def = getReviewerPrompt(context);
    expect(def.prompt).not.toContain('Use the available sub-agents');
  });

  it('can suppress response format guidance for schema-backed review output', () => {
    const def = getReviewerPrompt(
      context,
      undefined,
      undefined,
      undefined,
      false,
      false,
      undefined,
      false,
      true
    );
    expect(def.prompt).not.toContain('## Response Format');
    expect(def.prompt).not.toContain('Found Issues:');
    expect(def.prompt).not.toContain('**VERDICT:**');
    expect(def.prompt).toContain('## Critical Issues to Flag');
  });

  it('directs PR descriptions to copy manual testing runbooks from plan context', () => {
    const def = getPrDescriptionPrompt(`# Plan Context

## Manual Testing Runbooks

### Dashboard widget
1. Open the dashboard.
2. Confirm the widget renders.`);

    expect(def.prompt).toContain('### 7. Manual Testing Runbooks');
    expect(def.prompt).toContain('copy those runbooks into the PR description');
    expect(def.prompt).toContain('Preserve the runbook titles, steps, preconditions');
    expect(def.prompt).toContain('Dashboard widget');
  });

  it('directs PR descriptions to summarize out-of-scope and sibling-plan work', () => {
    const def = getPrDescriptionPrompt(`# Sibling Plan Scope

**Sibling Plan ID:** 42
**Sibling Title:** Follow-up permissions`);

    expect(def.prompt).toContain('Include an "Out of scope" subsection');
    expect(def.prompt).toContain('any adjacent work assigned to sibling plans');
    expect(def.prompt).toContain('None identified.');
  });
});
