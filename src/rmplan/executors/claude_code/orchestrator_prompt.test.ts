import { describe, it, expect } from 'bun:test';
import { wrapWithOrchestration } from './orchestrator_prompt.ts';

describe('orchestrator_prompt failure protocol', () => {
  it('includes failure protocol with FAILED detection and propagation', () => {
    const out = wrapWithOrchestration('Some task context', '123', { batchMode: false });
    expect(out).toContain('Failure Protocol');
    expect(out).toContain('FAILED:');
    expect(out).toContain('Monitor all subagent outputs');
  });

  it('mentions progress notes capability and example command', () => {
    const out = wrapWithOrchestration('Context', '123', { batchMode: true });
    // Should include a Progress Notes section and the add-progress-note command with plan id
    expect(out).toContain('Progress Notes');
    expect(out).toContain('rmplan add-progress-note 123 "<note text>"');
  });
});
