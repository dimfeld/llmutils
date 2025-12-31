import { describe, it, expect } from 'bun:test';
import { buildCodexOrchestrationPrompt } from './prompt.ts';

describe('buildCodexOrchestrationPrompt', () => {
  it('includes progress update guidance and template', () => {
    const prompt = buildCodexOrchestrationPrompt('Context', {
      planId: '152',
      planTitle: 'Progress Guidance',
      planFilePath: '/plans/152.plan.md',
      batchMode: false,
    });

    expect(prompt).toContain('Progress Updates (Plan File)');
    expect(prompt).toContain('/plans/152.plan.md');
    expect(prompt).toContain("update the plan file's `## Current Progress` section");
    expect(prompt).toContain('No timestamps');
    expect(prompt).toContain('## Current Progress');
    expect(prompt).toContain('### Current State');
    expect(prompt).toContain('### Remaining');
    expect(prompt).toContain('### Risks / Blockers');
  });
});
