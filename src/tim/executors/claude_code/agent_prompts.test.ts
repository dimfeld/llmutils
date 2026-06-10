import { describe, it, expect, vi } from 'vitest';
import {
  getImplementerPrompt,
  getTddTestsPrompt,
  getTesterPrompt,
  getReviewerPrompt,
  getPrDescriptionPrompt,
  buildReviewerSimplificationGuidance,
  FAILED_PROTOCOL_INSTRUCTIONS,
} from './agent_prompts.ts';

describe('agent_prompts failure protocol integration', () => {
  const context = 'Context and Task...';

  it('includes FAILED protocol in implementer prompt', () => {
    const def = getImplementerPrompt(context);
    expect(def.prompt).toContain('FAILED:');
    expect(def.prompt).toContain('Failure Protocol');
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

  it('emphasizes critical requirements mismatches in reviewer prompt', () => {
    const def = getReviewerPrompt(context);
    expect(def.prompt).toContain('implemented but does not meet requirements is a CRITICAL issue');
  });

  it('requires project-root-relative file paths in reviewer findings', () => {
    const def = getReviewerPrompt(context);
    expect(def.prompt).toContain(
      'When you reference files in your findings, use file paths relative to the project root. Do not use absolute paths.'
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
