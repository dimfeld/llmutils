import { describe, expect, it } from 'vitest';
import {
  wrapWithOrchestration,
  wrapWithOrchestrationSimple,
  wrapWithOrchestrationTdd,
} from './orchestrator_prompt.ts';
import { wrapForExecutionMode, type OrchestrationExecutionMode } from './orchestration_wrapper.ts';
import {
  buildFinalBatchReviewGuidance,
  buildFullPlanReviewCommand,
  buildReviewCommand,
  buildReviewIterationGuidance,
} from './review_guidance.ts';
import type { OrchestrationOptions } from './orchestration_options.ts';

type WrapperName = 'normal' | 'simple' | 'tdd' | 'tdd-simple';

interface PromptWrapper {
  name: WrapperName;
  build: (options: OrchestrationOptions) => string;
  legacyRoles: readonly string[];
}

const wrappers: readonly PromptWrapper[] = [
  {
    name: 'normal',
    build: (options: OrchestrationOptions): string =>
      wrapWithOrchestration('activation context', '421', options),
    legacyRoles: ['implementer', 'tester', 'reviewer'],
  },
  {
    name: 'simple',
    build: (options: OrchestrationOptions): string =>
      wrapWithOrchestrationSimple('activation context', '421', options),
    legacyRoles: ['implementer', 'reviewer'],
  },
  {
    name: 'tdd',
    build: (options: OrchestrationOptions): string =>
      wrapWithOrchestrationTdd('activation context', '421', options),
    legacyRoles: ['tdd-tests', 'implementer', 'tester', 'reviewer'],
  },
  {
    name: 'tdd-simple',
    build: (options: OrchestrationOptions): string =>
      wrapWithOrchestrationTdd('activation context', '421', {
        ...options,
        simpleMode: true,
      }),
    legacyRoles: ['tdd-tests', 'implementer', 'reviewer'],
  },
];

const executorOptions: readonly OrchestrationOptions['subagentExecutor'][] = [
  undefined,
  'dynamic',
  'claude-code',
  'codex-cli',
];

function legacyCommand(role: string, executor: OrchestrationOptions['subagentExecutor']): string {
  const executorFlag =
    role !== 'reviewer' && (executor === 'claude-code' || executor === 'codex-cli')
      ? ` -x ${executor}`
      : '';
  return `tim subagent ${role} 421${executorFlag}`;
}

describe('collaborative orchestration activation matrix', () => {
  it.each(
    wrappers.flatMap((wrapper) =>
      [false, true].flatMap((batchMode) =>
        executorOptions.map((subagentExecutor) => ({ wrapper, batchMode, subagentExecutor }))
      )
    )
  )(
    '$wrapper.name enabled mode uses tools and no legacy role delegation (batch=$batchMode, executor=$subagentExecutor)',
    ({ wrapper, batchMode, subagentExecutor }) => {
      const output = wrapper.build({
        agentMessagingEnabled: true,
        batchMode,
        subagentExecutor,
        structuralReviewCompleted: false,
      });

      expect(output).toContain('## Collaborative Agent Tools');
      expect(output).toContain('separate from any built-in subagent creation or messaging tools');
      for (const tool of [
        'StartTimAgent',
        'ListTimAgents',
        'SendTimAgentMessage',
        'StopTimAgent',
      ]) {
        expect(output).toContain(tool);
      }
      expect(output).toContain(
        'Its type is one of `implementer`, `tester`, `tdd-tests`, or `reviewer`'
      );
      expect(output).toContain('executor is `claude-code` or `codex-cli`');
      expect(output).toContain('canonical names');
      expect(output).toContain('generated name');
      expect(output).toContain('eight nonterminal subagents');
      for (const state of ['starting', 'running-active', 'running-idle', 'finishing', 'stopping']) {
        expect(output).toContain(state);
      }
      for (const acknowledgement of ['steered', 'queued', 'started-idle-turn']) {
        expect(output).toContain(acknowledgement);
      }
      expect(output).toContain('trusted source attribution');
      expect(output).toContain(
        'Each subagent must send its final response to `orchestrator` with this tool before it finishes'
      );
      expect(output).toContain(
        "Treat the manager's terminal notification only as the lifecycle completion signal"
      );
      expect(output).toContain('All agents share one working directory');
      expect(output).toContain('file scope');
      expect(output).toContain('read-only and advisory');
      expect(output).toContain('tim review 421 --print --output-file <output_path>');
      expect(output).toContain(
        'tim review-issues reject 421 --from-review <output.json> --issue <n> --reason "..."'
      );
      expect(output).toContain('StartTimAgent or SendTimAgentMessage');
      expect(output).toContain(
        'enumerate in `--input` (or provide through `--input-file <paths...>`) the specific findings being re-checked'
      );
      if (!batchMode) {
        expect(output).toContain(
          'Pass relevant implementation and test notes to the formal reviewer with `--input <text>` or `--input-file <paths...>`.'
        );
      }
      expect(output).not.toContain('Scope every review-fix subagent run');
      expect(output).not.toContain('a subagent `--task-index`');
      expect(output).toContain('## Failure Protocol');
      expect(output).toContain('tim set-task-done 421 --title "<taskTitle>"');
      expect(output).toContain('After marking tasks done, commit your changes');
      expect(output).toContain('## Plan Documentation During Implementation');
      expect(output).toContain('## Progress Updates (Plan File)');

      expect(output).not.toMatch(/tim subagent (implementer|tester|tdd-tests|reviewer)/);
      expect(output).not.toMatch(/^- \*\*FinishTimAgent\*\*/m);
      expect(output).not.toMatch(/`(?:--input|--input-file|--task-index).*tim subagent/m);

      const reviewFixScopeStart = output.indexOf(
        'Scope every review-fix agent assignment with StartTimAgent or SendTimAgentMessage.'
      );
      const reviewFixScopeEnd = output.indexOf(
        'Scope only review-fix assignments.',
        reviewFixScopeStart
      );
      expect(reviewFixScopeStart).toBeGreaterThanOrEqual(0);
      expect(reviewFixScopeEnd).toBeGreaterThan(reviewFixScopeStart);
      expect(output.slice(reviewFixScopeStart, reviewFixScopeEnd)).not.toMatch(
        /--(?:task-index|input(?:-file)?)/
      );

      if (batchMode) {
        expect(output).toContain('Review the selected task batch yourself');
        expect(output).toContain('final-plan review sequence');
        expect(output).toContain('--structural-only');
        expect(output).toContain(
          'run `tim review 421 --print --output-file <output_path>` with `--since <that commit>`'
        );
        expect(output).toContain(
          'tim review-issues reject 421 --content "<the finding>" --file <path> --line <line> --reason "..."'
        );
      }

      if (subagentExecutor === 'claude-code' || subagentExecutor === 'codex-cli') {
        expect(output).toContain(
          `Use \`${subagentExecutor}\` as the executor value for every StartTimAgent call.`
        );
        expect(output).not.toContain(` -x ${subagentExecutor}`);
      } else {
        expect(output).toContain(
          'Choose `codex-cli` or `claude-code` in the executor field of each StartTimAgent call.'
        );
        expect(output).not.toContain(' -x codex-cli');
        expect(output).not.toContain(' -x claude-code');
      }
    }
  );

  it.each(
    wrappers.flatMap((wrapper) =>
      [false, true].flatMap((batchMode) =>
        executorOptions.map((subagentExecutor) => ({ wrapper, batchMode, subagentExecutor }))
      )
    )
  )(
    '$wrapper.name false and absent snapshots are identical and retain legacy delegation (batch=$batchMode, executor=$subagentExecutor)',
    ({ wrapper, batchMode, subagentExecutor }) => {
      const commonOptions: OrchestrationOptions = { batchMode, subagentExecutor };
      const absent = wrapper.build(commonOptions);
      const falseSnapshot = wrapper.build({ ...commonOptions, agentMessagingEnabled: false });

      expect(absent).toBe(falseSnapshot);
      for (const tool of [
        'StartTimAgent',
        'ListTimAgents',
        'SendTimAgentMessage',
        'StopTimAgent',
        'FinishTimAgent',
      ]) {
        expect(falseSnapshot).not.toContain(tool);
      }
      for (const role of wrapper.legacyRoles) {
        expect(falseSnapshot).toContain(legacyCommand(role, subagentExecutor));
      }
      if (subagentExecutor === 'claude-code' || subagentExecutor === 'codex-cli') {
        expect(falseSnapshot).toContain(` -x ${subagentExecutor}`);
      } else {
        expect(falseSnapshot).toContain('tim subagent');
      }
      expect(falseSnapshot).not.toContain('tim review 421');
    }
  );

  it.each(['normal', 'simple', 'tdd'] as const)(
    'execution-mode wrapper propagates enabled and disabled snapshots to %s',
    (mode: OrchestrationExecutionMode) => {
      const options: OrchestrationOptions = {
        agentMessagingEnabled: true,
        batchMode: true,
        simpleMode: mode === 'simple',
        subagentExecutor: 'claude-code',
      };
      const enabled = wrapForExecutionMode(mode, 'activation context', '421', options);
      const disabled = wrapForExecutionMode(mode, 'activation context', '421', {
        ...options,
        agentMessagingEnabled: false,
      });
      const absent = wrapForExecutionMode(mode, 'activation context', '421', {
        ...options,
        agentMessagingEnabled: undefined,
      });

      expect(enabled).toContain('StartTimAgent');
      expect(enabled).not.toContain('tim subagent');
      expect(disabled).toContain('tim subagent');
      expect(disabled).not.toContain('StartTimAgent');
      expect(absent).toBe(disabled);
    }
  );

  it('does not expose FinishTimAgent as a root-callable tool while explaining self-finish', () => {
    const output = wrapWithOrchestration('activation context', '421', {
      agentMessagingEnabled: true,
    });

    expect(output).toContain('FinishTimAgent is self-only');
    expect(output).toContain('The root cannot call it');
    expect(output).not.toMatch(/^.*(?:root|orchestrator).*call FinishTimAgent.*tool.*$/im);
    expect(output).not.toMatch(/^\s*- \*\*FinishTimAgent\*\*/m);
  });

  it.each(
    wrappers.flatMap((wrapper) =>
      [false, true].map((structuralReviewCompleted) => ({ wrapper, structuralReviewCompleted }))
    )
  )(
    'enabled $wrapper.name keeps formal review policy and gates the structural pass (completed=$structuralReviewCompleted)',
    ({ wrapper, structuralReviewCompleted }) => {
      const output = wrapper.build({
        agentMessagingEnabled: true,
        batchMode: true,
        structuralReviewCompleted,
        subagentExecutor: 'codex-cli',
      });

      expect(output).toContain(
        'tim review-issues reject 421 --from-review <output.json> --issue <n> --reason "..."'
      );
      expect(output).toContain(
        'Scope every review-fix agent assignment with StartTimAgent or SendTimAgentMessage.'
      );
      expect(output).toContain(
        'Include the owning task, exact file scope, accepted findings, constraints, and verification'
      );
      expect(output).toContain(
        'run `tim review 421 --print --output-file <output_path>` with `--since <that commit>`'
      );
      expect(output).toContain(
        'Review #1 is the full-plan bookend: run `tim review 421 --print --output-file <output_path>` without any `--task-index` or `--since` arguments'
      );
      expect(output).not.toContain('Scope every review-fix subagent run');
      expect(output).not.toContain(
        'Include the findings being fixed in `--input` or `--input-file`'
      );
      expect(output).not.toMatch(/tim subagent (implementer|tester|tdd-tests|reviewer)/);
      expect(output).not.toMatch(/tim subagent [^\n]*(?:--task-index|--input|--input-file|-x)/);

      if (structuralReviewCompleted) {
        expect(output).not.toContain(
          'tim review 421 --print --output-file <output_path> --structural-only'
        );
        expect(output).toContain(
          'The standalone structural simplification pass has already run for this plan, so this run has no structural pass and no post-structural validation review.'
        );
        expect(output).not.toContain(
          'Only after the ordinary full-plan review loop has reached a Review Iteration Policy stopping condition'
        );
      } else {
        expect(output).toContain(
          'tim review 421 --print --output-file <output_path> --structural-only'
        );
        expect(output).toContain(
          'Only after the ordinary full-plan review loop has reached a Review Iteration Policy stopping condition'
        );
      }
    }
  );

  it.each(
    wrappers.flatMap((wrapper) => [false, true].map((batchMode) => ({ wrapper, batchMode })))
  )(
    'disabled $wrapper.name keeps legacy formal-review and review-fix delegation (batch=$batchMode)',
    ({ wrapper, batchMode }) => {
      const output = wrapper.build({
        agentMessagingEnabled: false,
        batchMode,
        structuralReviewCompleted: false,
        subagentExecutor: 'codex-cli',
      });

      for (const tool of [
        'StartTimAgent',
        'ListTimAgents',
        'SendTimAgentMessage',
        'StopTimAgent',
        'FinishTimAgent',
      ]) {
        expect(output).not.toContain(tool);
      }
      expect(output).toContain('Scope every review-fix subagent run');
      expect(output).toContain('Include the findings being fixed in `--input` or `--input-file`');
      expect(output).toContain('tim subagent reviewer 421 --print --output-file <output_path>');
      for (const role of wrapper.legacyRoles) {
        const executorFlag = role === 'reviewer' ? '' : ' -x codex-cli';
        expect(output).toContain(`tim subagent ${role} 421${executorFlag}`);
      }

      if (batchMode) {
        expect(output).toContain(
          'tim subagent reviewer 421 --print --output-file <output_path> --structural-only'
        );
        expect(output).toContain('Review the selected task batch yourself');
        expect(output).toContain('final-plan review sequence');
      } else {
        expect(output).not.toContain('--structural-only');
        expect(output).not.toContain('final-plan review sequence');
      }
    }
  );
});

describe('formal review rendering for collaborative activation', () => {
  it('selects tim review only for the enabled session snapshot', () => {
    expect(buildReviewCommand('421', { agentMessagingEnabled: true })).toBe(
      'tim review 421 --print --output-file <output_path>'
    );
    expect(
      buildReviewCommand('421', { agentMessagingEnabled: true, reviewExecutor: 'codex-cli' })
    ).toBe('tim review 421 --print --output-file <output_path> --executor codex-cli');
    expect(buildReviewCommand('421', { agentMessagingEnabled: false })).toBe(
      'tim subagent reviewer 421 --print --output-file <output_path>'
    );
    expect(buildReviewCommand('421', {})).toBe(
      'tim subagent reviewer 421 --print --output-file <output_path>'
    );
  });

  it('renders full-plan commands without an executor override in both modes', () => {
    expect(
      buildFullPlanReviewCommand('421', {
        agentMessagingEnabled: true,
        reviewExecutor: 'codex-cli',
      })
    ).toBe('tim review 421 --print --output-file <output_path>');
    expect(
      buildFullPlanReviewCommand('421', {
        agentMessagingEnabled: false,
        reviewExecutor: 'codex-cli',
      })
    ).toBe('tim subagent reviewer 421 --print --output-file <output_path>');
  });

  it.each([true, false])(
    'preserves review scope and severity policy (enabled=%s)',
    (enabled: boolean) => {
      const options: OrchestrationOptions = { agentMessagingEnabled: enabled, batchMode: false };
      const command = buildReviewCommand('421', options);
      const guidance = buildReviewIterationGuidance(command, options);

      expect(guidance).toContain(`run \`${command}\` with the same \`--task-index\` scope`);
      expect(guidance).toContain(
        `with \`--since <that commit>\` plus the same \`--task-index\` scope`
      );
      expect(guidance).toContain(
        'final review within the four-review budget is full declared scope'
      );
      expect(guidance).toContain('`critical` —');
      expect(guidance).toContain('`major` —');
      expect(guidance).toContain('`minor` —');
      expect(guidance).toContain('`info` —');
      expect(guidance).toContain('This is blocking.');
      expect(guidance).toContain('This is non-blocking.');
      expect(guidance).toContain('must NEVER by themselves trigger');
      expect(guidance).toContain('Allow at most 4 ordinary review runs per task batch');
      if (enabled) {
        expect(guidance).toContain('StartTimAgent or SendTimAgentMessage');
        expect(guidance).toContain(
          'enumerate in `--input` (or provide through `--input-file <paths...>`) the specific findings being re-checked'
        );
        expect(guidance).not.toContain('Include the findings being fixed in');
      } else {
        expect(guidance).not.toContain('StartTimAgent');
        expect(guidance).not.toContain('ListTimAgents');
        expect(guidance).not.toContain('SendTimAgentMessage');
        expect(guidance).not.toContain('StopTimAgent');
        expect(guidance).not.toContain('FinishTimAgent');
      }
    }
  );

  it('preserves structural and bounded handoff policy while changing only the enabled command spelling', () => {
    const enabled = buildFinalBatchReviewGuidance('421', {
      agentMessagingEnabled: true,
      batchMode: true,
      structuralReviewCompleted: false,
    });
    const disabled = buildFinalBatchReviewGuidance('421', {
      agentMessagingEnabled: false,
      batchMode: true,
      structuralReviewCompleted: false,
    });

    expect(enabled).toContain('tim review 421 --print --output-file <output_path>');
    expect(enabled).toContain(
      'tim review 421 --print --output-file <output_path> --structural-only'
    );
    expect(enabled).not.toContain('tim subagent reviewer');
    expect(disabled).toContain('tim subagent reviewer 421 --print --output-file <output_path>');
    expect(disabled).toContain(
      'tim subagent reviewer 421 --print --output-file <output_path> --structural-only'
    );
    expect(enabled).toContain('post-structural validation review');
    expect(enabled).toContain('Do not restart the ordinary review loop');
    expect(enabled).toContain('capture each remaining finding worth fixing in a follow-up task');
    expect(enabled).toContain('four-review budget');
    expect(enabled).not.toContain('StartTimAgent');
    expect(enabled).not.toContain('ListTimAgents');
    expect(enabled).not.toContain('SendTimAgentMessage');
    expect(enabled).not.toContain('StopTimAgent');
    expect(enabled).not.toContain('FinishTimAgent');
  });

  it('omits the structural command after the completed marker in both modes', () => {
    for (const agentMessagingEnabled of [true, false]) {
      const guidance = buildFinalBatchReviewGuidance('421', {
        agentMessagingEnabled,
        batchMode: true,
        structuralReviewCompleted: true,
      });

      expect(guidance).not.toContain('post-structural validation review, when needed');
      expect(guidance).toContain('this run has no structural pass');
      expect(guidance).toContain('no post-structural validation review');
      expect(guidance).toContain(
        'ordinary review loop reaches a Review Iteration Policy stopping condition'
      );
      expect(guidance).not.toContain('run exactly one standalone structural simplification pass');
    }
  });
});
