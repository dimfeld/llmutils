import { describe, it, expect } from 'bun:test';
import {
  wrapWithOrchestration,
  wrapWithOrchestrationSimple,
  wrapWithOrchestrationTdd,
} from './orchestrator_prompt.ts';

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
    expect(out).toContain('tim review 123 --output-file <unique-temp-file>');
    expect(out).toContain('15 minutes');
    expect(out).not.toContain('tim-reviewer');
  });

  it('includes review executor override when provided', () => {
    const out = wrapWithOrchestration('Context', '123', {
      batchMode: false,
      reviewExecutor: 'codex-cli',
    });
    expect(out).toContain('tim review 123 --output-file <unique-temp-file> --executor codex-cli');
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
    expect(out).toContain('tim subagent implementer abc');
    expect(out).toContain('tim subagent verifier abc');
    expect(out).toContain('implement → verify');
    expect(out).toContain('FAILED:');
  });

  it('includes batch instructions and verification commands in simple mode', () => {
    const out = wrapWithOrchestrationSimple('Context', 'abc', {
      batchMode: true,
      planFilePath: '/plans/test.plan.md',
    });
    expect(out).toContain('# Batch Task Processing Mode');
    expect(out).toContain('tim subagent verifier abc');
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

describe('orchestrator_prompt subagent commands', () => {
  describe('normal mode (wrapWithOrchestration)', () => {
    it('references tim subagent implementer and tester via Bash', () => {
      const out = wrapWithOrchestration('Context', '42', { batchMode: false });
      expect(out).toContain('tim subagent implementer 42');
      expect(out).toContain('tim subagent tester 42');
      expect(out).toContain('Bash tool');
      expect(out).toContain('1800000');
    });

    it('does not reference Task tool for subagent invocation', () => {
      const out = wrapWithOrchestration('Context', '42', { batchMode: false });
      expect(out).not.toContain('subagent_type=');
      expect(out).not.toContain('Task tool to invoke');
    });

    it('includes fixed -x flag when subagentExecutor is codex-cli', () => {
      const out = wrapWithOrchestration('Context', '42', {
        batchMode: false,
        subagentExecutor: 'codex-cli',
      });
      expect(out).toContain('tim subagent implementer 42 -x codex-cli');
      expect(out).toContain('tim subagent tester 42 -x codex-cli');
      // Should not include dynamic executor selection guidance
      expect(out).not.toContain('Subagent Executor Selection');
    });

    it('includes fixed -x flag when subagentExecutor is claude-code', () => {
      const out = wrapWithOrchestration('Context', '42', {
        batchMode: false,
        subagentExecutor: 'claude-code',
      });
      expect(out).toContain('tim subagent implementer 42 -x claude-code');
      expect(out).toContain('tim subagent tester 42 -x claude-code');
      expect(out).not.toContain('Subagent Executor Selection');
    });

    it('includes dynamic executor guidance when subagentExecutor is dynamic', () => {
      const out = wrapWithOrchestration('Context', '42', {
        batchMode: false,
        subagentExecutor: 'dynamic',
      });
      expect(out).toContain('Subagent Executor Selection');
      expect(out).toContain('Prefer claude-code for frontend tasks, codex-cli for backend tasks.');
      expect(out).toContain('-x codex-cli');
      expect(out).toContain('-x claude-code');
      // Commands should not have fixed executor flag
      expect(out).not.toContain('tim subagent implementer 42 -x codex-cli');
      expect(out).not.toContain('tim subagent implementer 42 -x claude-code');
    });

    it('includes dynamic executor guidance when subagentExecutor is not set', () => {
      const out = wrapWithOrchestration('Context', '42', { batchMode: false });
      expect(out).toContain('Subagent Executor Selection');
      expect(out).toContain('Prefer claude-code for frontend tasks, codex-cli for backend tasks.');
    });

    it('uses custom dynamic instructions when provided', () => {
      const out = wrapWithOrchestration('Context', '42', {
        batchMode: false,
        subagentExecutor: 'dynamic',
        dynamicSubagentInstructions: 'Always use codex for Rust, claude for TypeScript.',
      });
      expect(out).toContain('Subagent Executor Selection');
      expect(out).toContain('Always use codex for Rust, claude for TypeScript.');
      expect(out).not.toContain('Prefer claude-code for frontend');
    });

    it('delegates to subagents not directly in important guidelines', () => {
      const out = wrapWithOrchestration('Context', '42', { batchMode: false });
      expect(out).toContain('tim subagent');
      expect(out).toContain('--input');
      expect(out).toContain('--input-file');
      expect(out).toContain('DO NOT implement code directly');
    });

    it('includes large input guidance for input-file usage', () => {
      const out = wrapWithOrchestration('Context', '42', { batchMode: false });
      expect(out).toContain('roughly over 50KB');
      expect(out).toContain('--input-file <path>');
      expect(out).toContain('--input-file -');
    });
  });

  describe('simple mode (wrapWithOrchestrationSimple)', () => {
    it('references tim subagent implementer and verifier via Bash', () => {
      const out = wrapWithOrchestrationSimple('Context', '55', { batchMode: false });
      expect(out).toContain('tim subagent implementer 55');
      expect(out).toContain('tim subagent verifier 55');
      expect(out).toContain('Bash tool');
      expect(out).toContain('1800000');
    });

    it('does not reference Task tool for subagent invocation', () => {
      const out = wrapWithOrchestrationSimple('Context', '55', { batchMode: false });
      expect(out).not.toContain('subagent_type=');
      expect(out).not.toContain('Task tool');
    });

    it('includes fixed -x flag when subagentExecutor is codex-cli', () => {
      const out = wrapWithOrchestrationSimple('Context', '55', {
        batchMode: false,
        subagentExecutor: 'codex-cli',
      });
      expect(out).toContain('tim subagent implementer 55 -x codex-cli');
      expect(out).toContain('tim subagent verifier 55 -x codex-cli');
      expect(out).not.toContain('Subagent Executor Selection');
    });

    it('includes dynamic executor guidance when subagentExecutor is dynamic', () => {
      const out = wrapWithOrchestrationSimple('Context', '55', {
        batchMode: false,
        subagentExecutor: 'dynamic',
      });
      expect(out).toContain('Subagent Executor Selection');
      expect(out).toContain('Prefer claude-code for frontend tasks, codex-cli for backend tasks.');
    });

    it('uses custom dynamic instructions when provided', () => {
      const out = wrapWithOrchestrationSimple('Context', '55', {
        batchMode: false,
        subagentExecutor: 'dynamic',
        dynamicSubagentInstructions: 'Use codex for everything.',
      });
      expect(out).toContain('Use codex for everything.');
      expect(out).not.toContain('Prefer claude-code for frontend');
    });

    it('instructs to delegate work to subagents in important guidelines', () => {
      const out = wrapWithOrchestrationSimple('Context', '55', { batchMode: false });
      expect(out).toContain('tim subagent');
      expect(out).toContain('--input');
      expect(out).toContain('--input-file');
    });

    it('includes fixed -x flag when subagentExecutor is claude-code', () => {
      const out = wrapWithOrchestrationSimple('Context', '55', {
        batchMode: false,
        subagentExecutor: 'claude-code',
      });
      expect(out).toContain('tim subagent implementer 55 -x claude-code');
      expect(out).toContain('tim subagent verifier 55 -x claude-code');
      expect(out).not.toContain('Subagent Executor Selection');
    });

    it('does not include -x flag in commands when dynamic mode', () => {
      const out = wrapWithOrchestrationSimple('Context', '55', {
        batchMode: false,
        subagentExecutor: 'dynamic',
      });
      // The commands should NOT have a fixed -x flag embedded
      expect(out).not.toContain('tim subagent implementer 55 -x codex-cli');
      expect(out).not.toContain('tim subagent implementer 55 -x claude-code');
    });
  });

  describe('tdd mode (wrapWithOrchestrationTdd)', () => {
    it('includes tdd-tests before implementer and tester in normal TDD mode', () => {
      const out = wrapWithOrchestrationTdd('Context', '71', {
        batchMode: false,
        simpleMode: false,
      });
      expect(out).toContain('tim subagent tdd-tests 71');
      expect(out).toContain('tim subagent implementer 71');
      expect(out).toContain('tim subagent tester 71');
      expect(out).toContain('1. **TDD Test Phase**');
      expect(out).toContain('2. **Implementation Phase**');
      expect(out).toContain('3. **Testing Phase**');
      expect(out).toContain('4. **Review Phase**');
      expect(out).toContain('pass the TDD tests output');
    });

    it('uses verifier in TDD simple mode', () => {
      const out = wrapWithOrchestrationTdd('Context', '72', { batchMode: false, simpleMode: true });
      expect(out).toContain('tim subagent tdd-tests 72');
      expect(out).toContain('tim subagent implementer 72');
      expect(out).toContain('tim subagent verifier 72');
      expect(out).not.toContain('tim subagent tester 72');
      expect(out).toContain('3. **Verification Phase**');
      expect(out).not.toContain('Review Phase');
    });

    it('includes dynamic executor guidance for TDD mode when subagent executor is dynamic', () => {
      const out = wrapWithOrchestrationTdd('Context', '73', {
        batchMode: true,
        simpleMode: false,
        subagentExecutor: 'dynamic',
        dynamicSubagentInstructions: 'Use codex-cli for tests.',
      });
      expect(out).toContain('Subagent Executor Selection');
      expect(out).toContain('Use codex-cli for tests.');
      expect(out).toContain('1. **Task Selection Phase**');
      expect(out).toContain('2. **TDD Test Phase**');
    });

    it('includes fixed -x flag in TDD mode when subagent executor is fixed', () => {
      const out = wrapWithOrchestrationTdd('Context', '74', {
        batchMode: false,
        subagentExecutor: 'claude-code',
      });
      expect(out).toContain('tim subagent tdd-tests 74 -x claude-code');
      expect(out).toContain('tim subagent implementer 74 -x claude-code');
      expect(out).not.toContain('Subagent Executor Selection');
    });
  });

  describe('dynamic executor note in workflow instructions', () => {
    it('includes inline executor choice note in normal mode when dynamic', () => {
      const out = wrapWithOrchestration('Context', '42', {
        batchMode: false,
        subagentExecutor: 'dynamic',
      });
      expect(out).toContain('Choose the appropriate executor');
      expect(out).toContain('-x claude-code');
      expect(out).toContain('-x codex-cli');
    });

    it('does not include inline executor choice note in normal mode when fixed', () => {
      const out = wrapWithOrchestration('Context', '42', {
        batchMode: false,
        subagentExecutor: 'codex-cli',
      });
      expect(out).not.toContain('Choose the appropriate executor');
    });

    it('includes inline executor choice note in simple mode when dynamic', () => {
      const out = wrapWithOrchestrationSimple('Context', '55', {
        batchMode: false,
        subagentExecutor: 'dynamic',
      });
      expect(out).toContain('Choose the appropriate executor');
    });

    it('does not include inline executor choice note in simple mode when fixed', () => {
      const out = wrapWithOrchestrationSimple('Context', '55', {
        batchMode: false,
        subagentExecutor: 'claude-code',
      });
      expect(out).not.toContain('Choose the appropriate executor');
    });

    it('includes inline executor choice note when subagentExecutor is undefined (defaults to dynamic)', () => {
      const out = wrapWithOrchestration('Context', '42', { batchMode: false });
      expect(out).toContain('Choose the appropriate executor');
    });
  });

  describe('batch mode combined with subagent executor options', () => {
    it('includes both batch instructions and fixed executor flag in normal mode', () => {
      const out = wrapWithOrchestration('Context', '42', {
        batchMode: true,
        planFilePath: '/path/to/plan.md',
        subagentExecutor: 'codex-cli',
      });
      expect(out).toContain('# Batch Task Processing Mode');
      expect(out).toContain('tim subagent implementer 42 -x codex-cli');
      expect(out).toContain('tim subagent tester 42 -x codex-cli');
      expect(out).not.toContain('Subagent Executor Selection');
    });

    it('includes both batch instructions and dynamic guidance in normal mode', () => {
      const out = wrapWithOrchestration('Context', '42', {
        batchMode: true,
        planFilePath: '/path/to/plan.md',
        subagentExecutor: 'dynamic',
        dynamicSubagentInstructions: 'Custom batch instructions.',
      });
      expect(out).toContain('# Batch Task Processing Mode');
      expect(out).toContain('Subagent Executor Selection');
      expect(out).toContain('Custom batch instructions.');
      // Task selection phase should be first in batch mode
      expect(out).toContain('1. **Task Selection Phase**');
    });

    it('includes both batch instructions and dynamic guidance in simple mode', () => {
      const out = wrapWithOrchestrationSimple('Context', '55', {
        batchMode: true,
        planFilePath: '/path/to/plan.md',
        subagentExecutor: 'dynamic',
      });
      expect(out).toContain('# Batch Task Processing Mode');
      expect(out).toContain('Subagent Executor Selection');
      expect(out).toContain('tim subagent implementer 55');
      expect(out).toContain('tim subagent verifier 55');
    });

    it('numbers workflow phases correctly in batch mode with normal orchestration', () => {
      const out = wrapWithOrchestration('Context', '42', {
        batchMode: true,
        planFilePath: '/plan.md',
      });
      // In batch mode, task selection is step 1, implementation is step 2
      expect(out).toContain('1. **Task Selection Phase**');
      expect(out).toContain('2. **Implementation Phase**');
      expect(out).toContain('3. **Testing Phase**');
      expect(out).toContain('4. **Review Phase**');
    });

    it('numbers workflow phases correctly in non-batch mode with normal orchestration', () => {
      const out = wrapWithOrchestration('Context', '42', { batchMode: false });
      // In non-batch mode, implementation is step 1 (no task selection)
      expect(out).toContain('1. **Implementation Phase**');
      expect(out).toContain('2. **Testing Phase**');
      expect(out).toContain('3. **Review Phase**');
      expect(out).not.toContain('Task Selection Phase');
    });
  });
});
