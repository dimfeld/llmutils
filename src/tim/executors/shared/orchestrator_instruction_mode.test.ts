import { describe, expect, it } from 'vitest';
import {
  wrapWithOrchestration,
  wrapWithOrchestrationSimple,
  wrapWithOrchestrationTdd,
} from './orchestrator_prompt.ts';
import type { OrchestrationOptions } from './orchestration_options.ts';
import {
  DEFAULT_ORCHESTRATOR_INSTRUCTION_MODE,
  resolveOrchestratorInstructionMode,
} from './orchestrator_instruction_mode.ts';

const wrappers = [
  ['normal', wrapWithOrchestration],
  ['simple', wrapWithOrchestrationSimple],
  ['tdd', wrapWithOrchestrationTdd],
] as const;

function buildAll(options: OrchestrationOptions): Array<[string, string]> {
  return wrappers.map(([name, wrap]) => [name, wrap('Context', '123', options)]);
}

describe('resolveOrchestratorInstructionMode', () => {
  it('defaults to detailed', () => {
    expect(DEFAULT_ORCHESTRATOR_INSTRUCTION_MODE).toBe('detailed');
    expect(resolveOrchestratorInstructionMode()).toBe('detailed');
    expect(resolveOrchestratorInstructionMode({})).toBe('detailed');
  });

  it('returns the configured mode when one is set', () => {
    expect(resolveOrchestratorInstructionMode({ orchestratorInstructionMode: 'delegated' })).toBe(
      'delegated'
    );
    expect(resolveOrchestratorInstructionMode({ orchestratorInstructionMode: 'detailed' })).toBe(
      'detailed'
    );
  });
});

describe('detailed instruction mode', () => {
  it('produces the same prompt as leaving the mode unset', () => {
    for (const [name, wrap] of wrappers) {
      const implicit = wrap('Context', '123', { batchMode: true });
      const explicit = wrap('Context', '123', {
        batchMode: true,
        orchestratorInstructionMode: 'detailed',
      });
      expect(explicit, name).toBe(implicit);
    }
  });

  it('keeps the prescriptive subagent guidance', () => {
    for (const [name, out] of buildAll({ orchestratorInstructionMode: 'detailed' })) {
      expect(out, name).toContain('Subagents may use a less capable model than you.');
      expect(out, name).toContain(
        'name the files, required behavior, constraints, and verification steps'
      );
      expect(out, name).not.toContain('## Subagent Instruction Style');
    }
  });
});

describe('delegated instruction mode', () => {
  it('adds a subagent instruction style section to every wrapper', () => {
    for (const [name, out] of buildAll({ orchestratorInstructionMode: 'delegated' })) {
      expect(out, name).toContain('## Subagent Instruction Style');
      expect(out, name).toContain(
        'Name the plan tasks in scope and the outcome you expect, then let the subagent decide which files to change'
      );
      expect(out, name).toContain('Do not write a file-by-file implementation plan');
      expect(out, name).toContain(
        'You still own task selection, sequencing, every review gate, plan updates, and the integrated result.'
      );
    }
  });

  it('replaces the prescriptive capability guidance', () => {
    for (const [name, out] of buildAll({ orchestratorInstructionMode: 'delegated' })) {
      expect(out, name).not.toContain('Subagents may use a less capable model than you.');
      expect(out, name).not.toContain(
        'name the files, required behavior, constraints, and verification steps'
      );
      expect(out, name).toContain('Subagents are as capable as you are');
      expect(out, name).toContain('trust them to work out which files to touch');
    }
  });

  it('keeps the workflow gates and delegation requirements intact', () => {
    for (const [name, out] of buildAll({ orchestratorInstructionMode: 'delegated' })) {
      expect(out, name).toContain('Review Iteration Policy');
      expect(out, name).toContain('tim subagent implementer 123');
      expect(out, name).toContain('Failure Protocol');
    }
  });

  it('tells the normal wrapper what to include in subagent input', () => {
    const out = wrapWithOrchestration('Context', '123', {
      orchestratorInstructionMode: 'delegated',
    });
    expect(out).toContain('name the task titles in scope and the outcome you expect');
    expect(out).toContain('Leave the implementation specifics to them.');
  });

  it('tells the simple wrapper to leave implementation specifics to subagents', () => {
    const out = wrapWithOrchestrationSimple('Context', '123', {
      orchestratorInstructionMode: 'delegated',
    });
    expect(out).toContain('reference the specific task titles in scope and the outcome you expect');
  });

  it('applies to the collaborative agent-messaging prompts', () => {
    const options: OrchestrationOptions = {
      agentMessagingEnabled: true,
      orchestratorInstructionMode: 'delegated',
    };

    for (const [name, out] of buildAll(options)) {
      expect(out, name).toContain('## Subagent Instruction Style');
      expect(out, name).toContain(
        'its initial message must state the task and the expected handoff'
      );
      expect(out, name).toContain(
        'Give each subagent a clear outcome and the expected handoff, plus any constraint it cannot discover on its own.'
      );
      expect(out, name).toContain('the task titles in scope, and the expected handoff');
      expect(out, name).not.toContain(
        'an initial message containing plan `123`, the exact task and file scope, constraints, and expected handoff'
      );
      expect(out, name).toContain('StartTimAgent');
    }
  });

  it('keeps the collaborative prompts prescriptive in detailed mode', () => {
    const options: OrchestrationOptions = {
      agentMessagingEnabled: true,
      orchestratorInstructionMode: 'detailed',
    };

    for (const [name, out] of buildAll(options)) {
      expect(out, name).toContain(
        'its initial message must state the task, file scope, constraints, and expected handoff'
      );
      expect(out, name).toContain(
        'Give each subagent a clear outcome, file scope, constraints, verification steps, and expected handoff.'
      );
      expect(out, name).not.toContain('## Subagent Instruction Style');
    }
  });

  it('drops prescriptive phase wording in the collaborative TDD workflow', () => {
    const out = wrapWithOrchestrationTdd('Context', '123', {
      agentMessagingEnabled: true,
      orchestratorInstructionMode: 'delegated',
    });

    expect(out).toContain('the behavior its tests must pin down');
    expect(out).toContain('Require it to report the expected failure reason.');
    expect(out).not.toContain(
      'with the exact task, files, expected behavior, and expected failure reason'
    );
    expect(out).toContain('State file ownership only where concurrent scopes could collide.');
  });
});
