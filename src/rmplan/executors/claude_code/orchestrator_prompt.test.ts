import { describe, it, expect } from 'bun:test';
import { wrapWithOrchestration, wrapWithOrchestrationSimple } from './orchestrator_prompt.ts';

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
    expect(out).toContain('rmplan add-progress-note 123');
    expect(out).toContain('--source "<agent>: <task>"');
  });

  it('includes progress notes guidance in non-batch mode as well', () => {
    const out = wrapWithOrchestration('Context', '999', { batchMode: false });
    expect(out).toContain('Progress Notes');
    expect(out).toContain('rmplan add-progress-note 999');
    expect(out).toContain('--source "<agent>: <task>"');
  });

  it('wraps content with two-phase instructions in simple mode', () => {
    const out = wrapWithOrchestrationSimple('Context', 'abc', { batchMode: false });
    expect(out).toContain('Two-Phase Orchestration Instructions');
    expect(out).toContain('rmplan-abc-implementer');
    expect(out).toContain('rmplan-abc-verifier');
    expect(out).toContain('implement → verify');
    expect(out).toContain('FAILED:');
  });

  it('includes batch instructions and verification commands in simple mode', () => {
    const out = wrapWithOrchestrationSimple('Context', 'abc', {
      batchMode: true,
      planFilePath: '/plans/test.plan.md',
    });
    expect(out).toContain('# Batch Task Processing Mode');
    expect(out).toContain('Invoke the verifier agent');
    expect(out).toContain('bun run check');
    expect(out).toContain('@/plans/test.plan.md');
  });
});
