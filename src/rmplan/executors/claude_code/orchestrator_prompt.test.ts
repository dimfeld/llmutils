import { describe, it, expect } from 'bun:test';
import { wrapWithOrchestration } from './orchestrator_prompt.ts';

describe('orchestrator_prompt failure protocol', () => {
  it('includes failure protocol with FAILED detection and propagation', () => {
    const out = wrapWithOrchestration('Some task context', '123', { batchMode: false });
    expect(out).toContain('Failure Protocol');
    expect(out).toContain('FAILED:');
    expect(out).toContain('Monitor all subagent outputs');
  });
});

