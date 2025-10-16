import { describe, it, expect } from 'bun:test';
import {
  getImplementerPrompt,
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

  it('includes FAILED protocol in reviewer prompt', () => {
    const def = getReviewerPrompt(context);
    expect(def.prompt).toContain('FAILED:');
    expect(def.prompt).toContain('Failure Protocol');
  });

  it('omits progress note instructions when no plan id is provided', () => {
    const def = getImplementerPrompt(context);
    expect(def.prompt).not.toContain('rmplan add-progress-note');
  });

  it('includes progress note instructions when plan id is provided', () => {
    const def = getImplementerPrompt(context, '42');
    expect(def.prompt).toContain('rmplan add-progress-note 42');
    expect(def.prompt).toContain('--source');
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

  it('includes progress note guidance for verifier when plan id provided', () => {
    const verifier = getVerifierAgentPrompt(context, '77');
    expect(verifier.prompt).toContain('rmplan add-progress-note 77');
    expect(verifier.prompt).toContain('--source "<agent>: <task>"');
  });
});
