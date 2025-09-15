import { describe, it, expect } from 'bun:test';
import {
  getImplementerPrompt,
  getTesterPrompt,
  getReviewerPrompt,
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
});
