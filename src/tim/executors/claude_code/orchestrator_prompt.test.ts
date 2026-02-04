import { describe, it, expect } from 'bun:test';
import { wrapWithOrchestration, wrapWithOrchestrationSimple } from './orchestrator_prompt.ts';

describe('orchestrator_prompt failure protocol', () => {
  it('includes failure protocol with FAILED detection and propagation', () => {
    const out = wrapWithOrchestration('Some task context', '123', { batchMode: false });
    expect(out).toContain('Failure Protocol');
    expect(out).toContain('FAILED:');
    expect(out).toContain('Monitor all subagent outputs');
    expect(out).toContain('tim review');
  });

  it('mentions progress section update guidance for plan file', () => {
    const out = wrapWithOrchestration('Context', '123', { batchMode: true });
    expect(out).toContain('Progress Updates (Plan File)');
    expect(out).toContain('Update in place');
    expect(out).toContain('No timestamps');
    expect(out).toContain('## Current Progress');
    expect(out).toContain('### Current State');
  });

  it('instructs review via tim review instead of reviewer agent', () => {
    const out = wrapWithOrchestration('Context', '123', { batchMode: false });
    expect(out).toContain('tim review 123 --print --serial-both');
    expect(out).toContain('15 minutes');
    expect(out).not.toContain('tim-reviewer');
  });

  it('includes review executor override when provided', () => {
    const out = wrapWithOrchestration('Context', '123', {
      batchMode: false,
      reviewExecutor: 'codex-cli',
    });
    expect(out).toContain('tim review 123 --print --serial-both --executor codex-cli');
  });

  it('includes progress section guidance in non-batch mode as well', () => {
    const out = wrapWithOrchestration('Context', '999', { batchMode: false });
    expect(out).toContain('Progress Updates (Plan File)');
    expect(out).toContain('Update in place');
    expect(out).toContain('No timestamps');
  });

  it('wraps content with two-phase instructions in simple mode', () => {
    const out = wrapWithOrchestrationSimple('Context', 'abc', { batchMode: false });
    expect(out).toContain('Two-Phase Orchestration Instructions');
    expect(out).toContain('tim-implementer');
    expect(out).toContain('tim-verifier');
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

  it('includes progress section instructions in simple mode prompts', () => {
    const out = wrapWithOrchestrationSimple('Context', '007', { batchMode: false });
    expect(out).toContain('Progress Updates (Plan File)');
    expect(out).toContain('## Current Progress');
    expect(out).toContain('### Remaining');
  });
});
