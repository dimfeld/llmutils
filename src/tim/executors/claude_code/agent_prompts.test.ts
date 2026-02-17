import { describe, it, expect } from 'bun:test';
import {
  getImplementerPrompt,
  getTddTestsPrompt,
  getTesterPrompt,
  getReviewerPrompt,
  getVerifierAgentPrompt,
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

  it('includes commit scope guidance in all subagent prompts', () => {
    const expectedText = 'it is acceptable to include unexpected modified files in the same commit';
    expect(getImplementerPrompt(context).prompt).toContain(expectedText);
    expect(getTesterPrompt(context).prompt).toContain(expectedText);
    expect(getTddTestsPrompt(context).prompt).toContain(expectedText);
    expect(getVerifierAgentPrompt(context).prompt).toContain(expectedText);
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

  it('configures verifier prompt with verification commands and failure protocol', () => {
    const verifier = getVerifierAgentPrompt(context);
    expect(verifier.prompt).toContain('bun run check');
    expect(verifier.prompt).toContain('bun run lint');
    expect(verifier.prompt).toContain('bun test');
    expect(verifier.prompt).toContain('FAILED:');
  });

  it('directs verifier to report progress to orchestrator', () => {
    const verifier = getVerifierAgentPrompt(context, '77');
    expect(verifier.prompt).toContain('Progress Reporting');
    expect(verifier.prompt).toContain('Do NOT update the plan file directly');
    expect(verifier.prompt).not.toContain('Progress Updates (Plan File)');
  });

  it('appends custom instructions section to verifier prompt when provided', () => {
    const verifier = getVerifierAgentPrompt(
      context,
      '55',
      '  Follow project-specific QA checklist.  '
    );
    expect(verifier.prompt).toContain('## Custom Instructions');
    expect(verifier.prompt).toContain('Follow project-specific QA checklist.');
    expect(verifier.prompt).toContain('Progress Reporting');
  });
});
