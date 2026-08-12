import { describe, it, expect } from 'vitest';
import {
  wrapWithOrchestration,
  wrapWithOrchestrationSimple,
  wrapWithOrchestrationTdd,
} from './orchestrator_prompt.ts';
import { structuralPassApplies } from './review_guidance.ts';

describe('orchestrator_prompt failure protocol', () => {
  it('includes failure protocol with FAILED detection and evaluation guidance', () => {
    const out = wrapWithOrchestration('Some task context', '123', { batchMode: false });
    expect(out).toContain('Failure Protocol');
    expect(out).toContain('FAILED:');
    expect(out).toContain('Monitor all subagent outputs');
    expect(out).toContain('reviewer');
  });

  it('tells every orchestrator mode to evaluate recoverable failures before stopping', () => {
    const outputs = [
      wrapWithOrchestration('Context', '123', { batchMode: false }),
      wrapWithOrchestrationSimple('Context', '123', { batchMode: false }),
      wrapWithOrchestrationTdd('Context', '123', { batchMode: false }),
    ];

    for (const out of outputs) {
      expect(out).toContain(
        'A FAILED report is a signal to investigate, not an automatic reason to stop orchestration.'
      );
      expect(out).toContain('If the problem is fixable');
      expect(out).toContain('pre-existing error');
      expect(out).toContain('cannot be resolved without a user decision');
      expect(out).toContain('major expected functionality is missing');
      expect(out).toContain('Only after deciding that the failure is real should you stop');
    }
  });

  it('mentions progress section update guidance for plan file', () => {
    const out = wrapWithOrchestration('Context', '123', { batchMode: true });
    expect(out).toContain('Progress Updates (Plan File)');
    expect(out).toContain('Update in place');
    expect(out).toContain('No timestamps');
    expect(out).toContain('## Current Progress');
    expect(out).toContain('### Current State');
  });

  it('instructs review via reviewer subagent', () => {
    const out = wrapWithOrchestration('Context', '123', { batchMode: false });
    expect(out).toContain('tim subagent reviewer 123 --print');
    expect(out).not.toContain('--review-mode');
    expect(out).toContain('tim subagent reviewer 123 --input "<instructions>"');
    expect(out).toContain('reviewer may take a very long time');
  });

  it('warns every orchestration mode not to infer subagent timeouts', () => {
    const outputs = [
      wrapWithOrchestration('Context', '123'),
      wrapWithOrchestrationSimple('Context', '123'),
      wrapWithOrchestrationTdd('Context', '123'),
    ];

    for (const out of outputs) {
      expect(out).toContain('especially true for the reviewer');
      expect(out).toContain('integration tests, end-to-end tests');
      expect(out).toContain('Elapsed time or a lack of output is not a timeout');
      expect(out).toContain('never assume that a long-running subagent has timed out');
      expect(out).toContain('never stop, retry, or report it as failed for that reason');
      expect(out).not.toContain('15 minutes');
    }
  });

  it('requires a full-plan bookend review when a batch completes all remaining tasks', () => {
    const out = wrapWithOrchestration('Context', '123', {
      batchMode: true,
      reviewExecutor: 'codex-cli',
    });
    expect(out).toContain('without any `--task-index` or `--since` arguments');
    expect(out).toContain(
      'without any `--executor` option so the review runs with all configured agents for full coverage'
    );
    expect(out).not.toContain(
      'tim subagent reviewer 123 --print --output-file <output_path> --executor codex-cli'
    );
    expect(out).toContain('entire completed plan state is reviewed before you stop');
    expect(out).toContain('final-plan review sequence');
  });

  it('uses scoped review reruns until no new blocking findings or bounded handoff', () => {
    const out = wrapWithOrchestration('Context', '123', { batchMode: true });
    expect(out).toContain('follow the Review Iteration Policy');
    expect(out).toContain('intermediate fix-verification reruns 2..n');
    expect(out).toContain('--since <that commit>');
    expect(out).toContain(
      'The closing full-scope review is the last ordinary review inside the four-review budget, never an extra review.'
    );
    expect(out).toContain('produces no new blocking findings');
    expect(out).toContain('Review Iteration Policy');
    expect(out).toContain('issues earlier passes missed');
    expect(out).not.toContain('--review-mode');
    expect(out).not.toContain('--review-boundary');
  });

  it('makes the orchestrator analyze cascading findings and propose consolidation', () => {
    const out = wrapWithOrchestration('Context', '123', { batchMode: false });
    expect(out).toContain('the review command does not classify it for you');
    expect(out).toContain('Watch for cascading findings');
    expect(out).toContain('FIRST review that reports the same defect class at multiple locations');
    expect(out).toContain('root-cause checkpoint is orchestrator analysis');
    expect(out).toContain('concrete consolidation proposal');
    expect(out).toContain('consolidating responsibility');
  });

  it('bounds ordinary reviews and hands remaining feedback to follow-up tasks', () => {
    const out = wrapWithOrchestration('Context', '123', { batchMode: true });
    expect(out).toContain('Allow at most 4 ordinary review runs per task batch');
    expect(out).toContain('the fourth ordinary review has completed');
    expect(out).toContain('do not run another ordinary review as part of this iteration loop');
    expect(out).toContain('allowed in addition to this limit');
    expect(out).toContain('A finding captured in a follow-up task is handled');
    expect(out).toContain('mark the original in-scope tasks done');
    expect(out).not.toContain('at most 3 or 4 review runs');
  });

  it('distinguishes orchestrator analysis from the formal reviewer quality gate', () => {
    const outputs = [
      wrapWithOrchestration('Context', '123', { batchMode: false }),
      wrapWithOrchestrationSimple('Context', '123', { batchMode: false }),
      wrapWithOrchestrationTdd('Context', '123', { batchMode: false }),
    ];

    for (const out of outputs) {
      expect(out).toContain(
        'Do not substitute your own review for the formal reviewer quality gate'
      );
      expect(out).toContain('You may inspect code as needed');
      expect(out).toContain('This analysis does not replace a required reviewer pass');
    }
  });

  it('reminds the orchestrator to give specific instructions to subagents', () => {
    const outputs = [
      wrapWithOrchestration('Context', '123'),
      wrapWithOrchestrationSimple('Context', '123'),
      wrapWithOrchestrationTdd('Context', '123'),
    ];

    for (const out of outputs) {
      expect(out).toContain('Subagents may use a less capable model than you.');
      expect(out).toContain(
        'name the files, required behavior, constraints, and verification steps'
      );
    }
  });

  it('runs structural review only after an ordinary review stopping condition', () => {
    const out = wrapWithOrchestration('Context', '123', { batchMode: true });
    expect(out).toContain(
      'Only after the ordinary full-plan review loop has reached a Review Iteration Policy stopping condition—no new blocking findings, or the bounded handoff completed—run exactly one standalone structural simplification pass'
    );
    expect(out).toContain('--structural-only');
    expect(out).toContain(
      'reached a Review Iteration Policy stopping condition—no new blocking findings, or the bounded handoff completed'
    );
    expect(out).toContain('run exactly one complete ordinary review afterward');
    expect(out).toContain('even if four ordinary reviews already ran');
    expect(out).toContain('explicit exception to the ordinary review run limit');
    expect(out).toContain('Do not restart the ordinary review loop');
    expect(out).toContain('Do not rerun the structural pass automatically');
  });

  it('includes review executor override when provided', () => {
    const out = wrapWithOrchestration('Context', '123', {
      batchMode: false,
      reviewExecutor: 'codex-cli',
    });
    expect(out).toContain(
      'tim subagent reviewer 123 --print --output-file <output_path> --executor codex-cli'
    );
  });

  it('allows small review follow-ups without re-running implementer/reviewer', () => {
    const out = wrapWithOrchestration('Context', '123', { batchMode: false });
    expect(out).toContain(
      'you may apply the changes yourself without spawning the implementer subagent'
    );
    expect(out).toContain('focused logic adjustments');
    expect(out).toContain(
      'repeat `tim subagent reviewer 123 --print --output-file <output_path>` according to the Review Iteration Policy'
    );
  });

  it('supports persistent subagent handoffs across workflow phases', () => {
    const out = wrapWithOrchestration('Context', '123', {
      agentMessagingEnabled: true,
      batchMode: false,
    });

    expect(out).toContain(
      'Any subagent may send progress and remain active while another phase runs'
    );
    expect(out).toContain(
      'For a multi-phase assignment, state that the agent should remain available'
    );
    expect(out).toContain(
      'Keep subagent assignments active across implementation, review, and follow-up turns'
    );
    expect(out).toContain(
      'Prefer sending accepted review findings to the existing active implementer'
    );
    expect(out).toContain(
      'An advisory StartTimAgent reviewer may also remain active while the implementer fixes feedback'
    );
    expect(out).toContain(
      'send it directly to that reviewer for another read-only verification pass'
    );
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
    expect(out).toContain('tim subagent reviewer abc --print');
    expect(out).toContain('implement → review');
    expect(out).toContain('FAILED:');
  });

  it('uses orchestrator-owned batch review and reserves reviewer command for full-plan review', () => {
    const out = wrapWithOrchestrationSimple('Context', 'abc', {
      batchMode: true,
      planFilePath: '/plans/test.plan.md',
    });
    expect(out).toContain('# Batch Task Processing Mode');
    expect(out).toContain('Review the selected task batch yourself');
    expect(out).toContain('start your own native subagent');
    expect(out).toContain('Do not run `tim subagent reviewer` for this selected-task batch review');
    expect(out).toContain('tim subagent reviewer abc --print');
    expect(out).not.toContain('--task-index 1');
    expect(out).toContain('final-plan review sequence');
    expect(out).toContain('@/plans/test.plan.md');
    expect(out).toContain('Review Iteration Policy');
  });

  it.each([
    {
      name: 'wrapWithOrchestration',
      planId: '123',
      phaseNumber: '4',
      output: wrapWithOrchestration('Context', '123', { batchMode: true }),
    },
    {
      name: 'wrapWithOrchestrationSimple',
      planId: '456',
      phaseNumber: '3',
      output: wrapWithOrchestrationSimple('Context', '456', { batchMode: true }),
    },
    {
      name: 'wrapWithOrchestrationTdd',
      planId: '789',
      phaseNumber: '5',
      output: wrapWithOrchestrationTdd('Context', '789', { batchMode: true, simpleMode: false }),
    },
    {
      name: 'wrapWithOrchestrationTdd (simple)',
      planId: '1011',
      phaseNumber: '4',
      output: wrapWithOrchestrationTdd('Context', '1011', { batchMode: true, simpleMode: true }),
    },
  ])(
    'renders the same complete batch-review guidance in $name',
    ({
      output,
      planId,
      phaseNumber,
    }: {
      output: string;
      planId: string;
      phaseNumber: string;
    }): void => {
      const expectedLines: string[] = [
        `${phaseNumber}. **Review Phase**`,
        'Review the selected task batch yourself. Inspect the implementation, diff, tests, and relevant plan requirements for correctness, regressions, missing coverage, and maintainability.',
        'start your own native subagent to review all or part of the selected task batch if that would help',
        'Do not run `tim subagent reviewer` for this selected-task batch review. That command is reserved for the final full-plan review after every task is complete.',
        `tim review-issues reject ${planId} --content "<the finding>" --file <path> --line <line> --reason "..."`,
        `tim review-issues reject ${planId} --from-review <output.json> --issue <n> --reason "..."`,
        'Your review should focus on problems; lack of findings means the batch review passed.',
      ];

      for (const line of expectedLines) {
        expect(output).toContain(line);
      }
    }
  );

  it('references configured reviewer instructions for orchestrator-owned batch reviews', () => {
    const options = {
      batchMode: true,
      reviewerInstructionsPath: 'instructions/reviewer.md',
    };
    const outputs = [
      wrapWithOrchestration('Context', '123', options),
      wrapWithOrchestrationSimple('Context', '123', options),
      wrapWithOrchestrationTdd('Context', '123', { ...options, simpleMode: false }),
      wrapWithOrchestrationTdd('Context', '123', { ...options, simpleMode: true }),
    ];

    for (const out of outputs) {
      expect(out).toContain(
        'read and follow the reviewer subagent instructions at `instructions/reviewer.md`'
      );
      expect(out).toContain('Apply this review-specific guidance to your per-batch review');
      expect(out).not.toContain('`@instructions/reviewer.md`');
    }
  });

  it('omits reviewer instruction guidance when it is not configured or not in batch mode', () => {
    const unconfigured = wrapWithOrchestration('Context', '123', { batchMode: true });
    const nonBatch = wrapWithOrchestration('Context', '123', {
      batchMode: false,
      reviewerInstructionsPath: 'instructions/reviewer.md',
    });

    expect(unconfigured).not.toContain('reviewer subagent instructions at');
    expect(nonBatch).not.toContain('reviewer subagent instructions at');
  });

  it('includes progress section instructions in simple mode prompts', () => {
    const out = wrapWithOrchestrationSimple('Context', '007', { batchMode: false });
    expect(out).toContain('Progress Updates (Plan File)');
    expect(out).toContain('## Current Progress');
    expect(out).toContain('### Remaining');
  });
});

describe('orchestrator_prompt collaborative activation', () => {
  const wrappers = [
    {
      name: 'normal',
      build: (
        batchMode: boolean,
        subagentExecutor?: 'codex-cli' | 'claude-code' | 'dynamic',
        agentMessagingEnabled: boolean = true
      ) =>
        wrapWithOrchestration('Context', '421', {
          agentMessagingEnabled,
          batchMode,
          subagentExecutor,
        }),
    },
    {
      name: 'simple',
      build: (
        batchMode: boolean,
        subagentExecutor?: 'codex-cli' | 'claude-code' | 'dynamic',
        agentMessagingEnabled: boolean = true
      ) =>
        wrapWithOrchestrationSimple('Context', '421', {
          agentMessagingEnabled,
          batchMode,
          subagentExecutor,
        }),
    },
    {
      name: 'tdd',
      build: (
        batchMode: boolean,
        subagentExecutor?: 'codex-cli' | 'claude-code' | 'dynamic',
        agentMessagingEnabled: boolean = true
      ) =>
        wrapWithOrchestrationTdd('Context', '421', {
          agentMessagingEnabled,
          batchMode,
          simpleMode: false,
          subagentExecutor,
        }),
    },
  ] as const;

  it.each(
    wrappers.flatMap((wrapper) => [
      { ...wrapper, batchMode: false },
      { ...wrapper, batchMode: true },
    ])
  )(
    '$name enabled mode keeps collaborative delegation and formal review separate (batch=$batchMode)',
    ({ build, batchMode }) => {
      const output = build(batchMode, 'codex-cli');

      for (const tool of [
        'StartTimAgent',
        'ListTimAgents',
        'SendTimAgentMessage',
        'StopTimAgent',
      ]) {
        expect(output).toContain(tool);
      }
      expect(output).toContain('FinishTimAgent is self-only');
      expect(output).toContain('implementer');
      expect(output).toContain('tester');
      expect(output).toContain('tdd-tests');
      expect(output).toContain('reviewer');
      expect(output).toContain('claude-code');
      expect(output).toContain('codex-cli');
      expect(output).toContain('eight nonterminal subagents');
      expect(output).toContain('starting');
      expect(output).toContain('running-active');
      expect(output).toContain('running-idle');
      expect(output).toContain('finishing');
      expect(output).toContain('stopping');
      expect(output).toContain('steered');
      expect(output).toContain('queued');
      expect(output).toContain('started-idle-turn');
      expect(output).toContain('trusted source attribution');
      expect(output).toContain('All agents share one working directory');
      expect(output).toContain('## Agent Autonomy');
      expect(output).toContain('work independently');
      expect(output).toContain('do not poll it for routine progress updates');
      expect(output).toContain(
        'Do not stop an agent just because its expected work appears complete'
      );
      expect(output).toContain('file scope');
      expect(output).toContain('read-only and advisory');
      expect(output).toContain('tim review 421 --print --output-file <output_path>');
      expect(output).not.toMatch(/tim subagent (implementer|tester|tdd-tests|reviewer)/);
    }
  );

  it.each(wrappers)(
    '$name enabled mode supports fixed and dynamic executor selection',
    ({ build }) => {
      const fixed = build(false, 'claude-code');
      const dynamic = build(false, 'dynamic');

      expect(fixed).toContain(
        'Use `claude-code` as the executor value for every StartTimAgent call.'
      );
      expect(fixed).not.toContain(' -x claude-code');
      expect(dynamic).toContain('Choose `codex-cli` or `claude-code` in the executor field');
      expect(dynamic).toContain('Prefer claude-code for frontend tasks');
      expect(dynamic).not.toContain(' -x codex-cli');
    }
  );

  it('enabled TDD mode requires verified red evidence before each implementation scope', () => {
    const output = wrapWithOrchestrationTdd('Context', '421', {
      agentMessagingEnabled: true,
      batchMode: true,
      simpleMode: false,
      subagentExecutor: 'dynamic',
    });

    expect(output).toContain('Independent scopes may run their red phases concurrently');
    expect(output).toContain(
      "Do not start the implementer for a scope until that scope's red evidence is verified."
    );
    expect(output).toContain('expected failure reason');
    expect(output).toContain('expected behavioral reason');
    expect(output.indexOf('TDD Test Phase')).toBeLessThan(output.indexOf('Implementation Phase'));
    expect(output).not.toMatch(/tim subagent (tdd-tests|implementer|tester|reviewer)/);
  });

  it.each([
    {
      name: 'normal non-batch fixed',
      batchMode: false,
      simpleMode: false,
      subagentExecutor: 'codex-cli',
    },
    {
      name: 'normal batch fixed',
      batchMode: true,
      simpleMode: false,
      subagentExecutor: 'claude-code',
    },
    {
      name: 'simple non-batch dynamic',
      batchMode: false,
      simpleMode: true,
      subagentExecutor: 'dynamic',
    },
    {
      name: 'simple batch dynamic',
      batchMode: true,
      simpleMode: true,
      subagentExecutor: 'dynamic',
    },
  ] as const)(
    'enabled TDD matrix case $name preserves red-before-green ordering',
    (caseOptions) => {
      const output = wrapWithOrchestrationTdd('Context', '421', {
        agentMessagingEnabled: true,
        ...caseOptions,
      });

      expect(output).toContain('StartTimAgent with type `tdd-tests`');
      expect(output).toContain('StartTimAgent with type `implementer`');
      expect(output).toContain('red evidence is verified');
      expect(output).toContain('tim review 421 --print --output-file <output_path>');
      expect(output).not.toMatch(/tim subagent (tdd-tests|implementer|tester|reviewer)/);
      expect(output.indexOf('TDD Test Phase')).toBeLessThan(output.indexOf('Implementation Phase'));
    }
  );

  it.each(
    wrappers.flatMap((wrapper) => [
      { ...wrapper, batchMode: false },
      { ...wrapper, batchMode: true },
    ])
  )(
    '$name disabled matrix case keeps all messaging tools absent (batch=$batchMode)',
    ({ build, batchMode }) => {
      const output = build(batchMode, undefined, false);
      for (const tool of [
        'StartTimAgent',
        'ListTimAgents',
        'SendTimAgentMessage',
        'StopTimAgent',
        'FinishTimAgent',
      ]) {
        expect(output).not.toContain(tool);
      }
    }
  );

  it('enabled formal review guidance preserves the ordinary review policy', () => {
    const output = wrapWithOrchestration('Context', '421', {
      agentMessagingEnabled: true,
      batchMode: false,
    });

    expect(output).toContain('full declared scope');
    expect(output).toContain('--since <that commit>');
    expect(output).toContain('closing full-scope review');
    expect(output).toContain('critical` or `major`');
    expect(output).toContain('minor` or `info`');
    expect(output).toContain('at most 4 ordinary review runs');
    expect(output).not.toContain('tim subagent reviewer');
  });

  it('renders enabled full-plan and structural gates through tim review', () => {
    const output = wrapWithOrchestration('Context', '421', {
      agentMessagingEnabled: true,
      batchMode: true,
      structuralReviewCompleted: false,
      reviewExecutor: 'codex-cli',
    });

    expect(output).toContain('tim review 421 --print --output-file <output_path>');
    expect(output).toContain(
      'tim review 421 --print --output-file <output_path> --structural-only'
    );
    expect(output).not.toContain('tim subagent reviewer');
  });
});

describe('orchestrator_prompt rejected finding recording guidance', () => {
  const wrappers: Array<{
    name: string;
    planId: string;
    call: (batchMode: boolean) => string;
  }> = [
    {
      name: 'wrapWithOrchestration',
      planId: '123',
      call: (batchMode) => wrapWithOrchestration('Context', '123', { batchMode }),
    },
    {
      name: 'wrapWithOrchestrationSimple',
      planId: '456',
      call: (batchMode) => wrapWithOrchestrationSimple('Context', '456', { batchMode }),
    },
    {
      name: 'wrapWithOrchestrationTdd',
      planId: '789',
      call: (batchMode) =>
        wrapWithOrchestrationTdd('Context', '789', { batchMode, simpleMode: false }),
    },
    {
      name: 'wrapWithOrchestrationTdd (simple)',
      planId: '1011',
      call: (batchMode) =>
        wrapWithOrchestrationTdd('Context', '1011', { batchMode, simpleMode: true }),
    },
  ];

  it.each(wrappers)('$name records rejected findings in both modes', ({ call, planId }) => {
    for (const batchMode of [false, true]) {
      const out = call(batchMode);

      expect(out).toContain('After each rejection, immediately record the finding');
      expect(out).toContain(
        `tim review-issues reject ${planId} --from-review <output.json> --issue <n> --reason "..."`
      );
      expect(out).toContain(
        `tim review-issues reject ${planId} --from-review <output.json> --issue <n> --state non-blocking --reason "..."`
      );
      expect(out).toContain(`tim review-issues list ${planId}`);
      expect(out).toContain(`tim review-issues resolve ${planId} <issue-index>`);
      expect(out).toContain('For every saved `Non-blocking` finding');
      expect(out).toContain(
        'Later reviews load these dispositions automatically, so do not re-type them.'
      );
      expect(out).toContain(
        'If multiple findings in the same review describe the same underlying issue, record only one disposition; do not add a separate rejected issue for a duplicate.'
      );
      expect(out).toContain(
        'This often happens when different reviewer subagents report the same issue.'
      );
      expect(out).not.toContain(
        'not relevant or acceptable to leave as-is, so the reviewer knows not to flag them again'
      );
      expect(out).not.toContain(
        'issues from prior review output that you determined were not relevant'
      );
      if (!batchMode) {
        // The manual --input-file fallback for passing notes to the reviewer must survive
        // at the original (non-batch) sites, alongside the new automatic rejection guidance.
        expect(out).toContain(
          'via `--input-file <paths...>` so it has the full picture of what was intended and why'
        );
      }
    }
  });
});

describe('orchestrator_prompt batch-review rejection recording guidance', () => {
  const batchWrappers: Array<{
    name: string;
    planId: string;
    call: () => string;
  }> = [
    {
      name: 'wrapWithOrchestration',
      planId: '123',
      call: () => wrapWithOrchestration('Context', '123', { batchMode: true }),
    },
    {
      name: 'wrapWithOrchestrationSimple',
      planId: '456',
      call: () => wrapWithOrchestrationSimple('Context', '456', { batchMode: true }),
    },
    {
      name: 'wrapWithOrchestrationTdd',
      planId: '789',
      call: () =>
        wrapWithOrchestrationTdd('Context', '789', { batchMode: true, simpleMode: false }),
    },
    {
      name: 'wrapWithOrchestrationTdd (simple)',
      planId: '1011',
      call: () =>
        wrapWithOrchestrationTdd('Context', '1011', { batchMode: true, simpleMode: true }),
    },
  ];

  it.each(batchWrappers)(
    '$name records batch-review rejections with the explicit-field form and real plan id',
    ({ call, planId }) => {
      const out = call();

      expect(out).toContain(
        `tim review-issues reject ${planId} --content "<the finding>" --file <path> --line <line> --reason "..."`
      );
      expect(out).toContain('This review produces no reviewer output file');
      expect(out).toContain(
        'If multiple findings in the same review describe the same underlying issue, record only one disposition; do not add a separate rejected issue for a duplicate.'
      );
      expect(out).not.toContain(`--from-review <output.json> --issue <n>" --content`);
      // The --from-review guidance for the final full-plan reviewer command must still be present
      // alongside the new batch-review guidance; this addition must not displace it.
      expect(out).toContain(
        `tim review-issues reject ${planId} --from-review <output.json> --issue <n> --reason "..."`
      );
    }
  );

  it('non-batch mode does not emit batch-review rejection guidance', () => {
    const outputs = [
      wrapWithOrchestration('Context', '123', { batchMode: false }),
      wrapWithOrchestrationSimple('Context', '456', { batchMode: false }),
      wrapWithOrchestrationTdd('Context', '789', { batchMode: false, simpleMode: false }),
      wrapWithOrchestrationTdd('Context', '1011', { batchMode: false, simpleMode: true }),
    ];

    for (const out of outputs) {
      expect(out).not.toContain('--content "<the finding>" --file <path> --line <line>');
      expect(out).not.toContain('This review produces no reviewer output file');
    }
  });
});

describe('orchestrator_prompt review iteration policy (plan 394 task 8)', () => {
  const wrappers: Array<{
    name: string;
    call: (batchMode: boolean) => string;
  }> = [
    {
      name: 'wrapWithOrchestration',
      call: (batchMode) =>
        wrapWithOrchestration('Context', '123', {
          batchMode,
          planFilePath: batchMode ? '/tmp/x.plan.md' : undefined,
        }),
    },
    {
      name: 'wrapWithOrchestrationSimple',
      call: (batchMode) =>
        wrapWithOrchestrationSimple('Context', '123', {
          batchMode,
          planFilePath: batchMode ? '/tmp/x.plan.md' : undefined,
        }),
    },
    {
      name: 'wrapWithOrchestrationTdd (normal)',
      call: (batchMode) =>
        wrapWithOrchestrationTdd('Context', '123', {
          batchMode,
          simpleMode: false,
          planFilePath: batchMode ? '/tmp/x.plan.md' : undefined,
        }),
    },
    {
      name: 'wrapWithOrchestrationTdd (simple)',
      call: (batchMode) =>
        wrapWithOrchestrationTdd('Context', '123', {
          batchMode,
          simpleMode: true,
          planFilePath: batchMode ? '/tmp/x.plan.md' : undefined,
        }),
    },
  ];

  describe.each(wrappers)('$name', ({ call }) => {
    it('non-batch mode: states the three-tier scope rule and drops the blanket no-narrowing rule', () => {
      const out = call(false);
      expect(out).toContain('Apply this budgeted three-tier scope rule to ordinary reviews.');
      expect(out).toContain(
        '(1) The first ordinary review of a task batch covers the full declared scope'
      );
      expect(out).toContain('(2) Intermediate fix-verification reviews are diff-scoped');
      expect(out).toContain(
        '(3) Whenever the loop is about to stop because a complete review produced no new blocking findings or because the four-review bound is reached'
      );
      expect(out).toContain(
        'The closing full-scope review is the last ordinary review inside the four-review budget, never an extra review.'
      );
      expect(out).toContain('If the bound is reached, review #4 is the closing full-scope review');
      expect(out).not.toContain('Do not narrow a follow-up review to only the files changed');
    });

    it('non-batch mode: instructs recording the commit hash and using --since for fix-verification reviews', () => {
      const out = call(false);
      expect(out).toContain('immediately BEFORE applying fixes, record the current commit hash');
      expect(out).toContain('git rev-parse HEAD');
      expect(out).toContain('jj log --no-graph -r @- -T commit_id');
      expect(out).toContain(
        'run `tim subagent reviewer 123 --print --output-file <output_path>` with `--since <that commit>`'
      );
      expect(out).toContain('plus the same `--task-index` scope');
      expect(out).toContain(
        'enumerate in `--input` (or provide through `--input-file <paths...>`) the specific findings being re-checked'
      );
    });

    it('scopes subagent review fixes without changing initial implementation runs', () => {
      const out = call(false);
      expect(out).toContain(
        'Scope every review-fix subagent run. When you dispatch a subagent to fix review findings, pass repeatable or comma-separated `--task-index` values for exactly the task(s) that own the findings.'
      );
      expect(out).toContain(
        "The indexes are plan-absolute and 1-based, numbered over every plan task including completed ones, the same numbering the reviewer's `--task-index` uses."
      );
      expect(out).toContain('Include the findings being fixed in `--input` or `--input-file`');
      expect(out).toContain('not to touch code outside those findings');
      expect(out).toContain(
        'Scope only fix rounds. The first implementation, TDD-test, and testing run of a batch covers the tasks you selected and passes no `--task-index`; only a run that fixes review findings is scoped.'
      );
      expect(out).toContain('an index naming a completed task fails the command');
      expect(out).toContain(
        'omit `--task-index` entirely and state the scope of the fix in `--input` instead'
      );
      expect(out).toContain('Never mark a task incomplete to work around this');
    });

    it('states the review-fix task-index rule in batch mode too', () => {
      const out = call(true);
      expect(out).toContain(
        'Scope every review-fix subagent run. When you dispatch a subagent to fix review findings, pass repeatable or comma-separated `--task-index` values for exactly the task(s) that own the findings.'
      );
      expect(out).toContain(
        "The indexes are plan-absolute and 1-based, numbered over every plan task including completed ones, the same numbering the reviewer's `--task-index` uses."
      );
      expect(out).toContain('Include the findings being fixed in `--input` or `--input-file`');
      expect(out).toContain('not to touch code outside those findings');
      expect(out).toContain(
        'Scope only fix rounds. The first implementation, TDD-test, and testing run of a batch covers the tasks you selected and passes no `--task-index`; only a run that fixes review findings is scoped.'
      );
    });

    it('states the completed-task exception: omit --task-index and describe scope in --input instead', () => {
      for (const batchMode of [false, true]) {
        const out = call(batchMode);
        expect(out).toContain(
          'Unlike the reviewer, a subagent `--task-index` accepts only tasks that are still incomplete; an index naming a completed task fails the command.'
        );
        expect(out).toContain('If the task that owns a finding is already marked done');
        expect(out).toContain(
          'common in the final full-plan sequence, where earlier iterations have already completed their tasks'
        );
        expect(out).toContain(
          'omit `--task-index` entirely and state the scope of the fix in `--input` instead'
        );
        expect(out).toContain('Never mark a task incomplete to work around this.');
      }
    });

    it('does not loop on unqualified review feedback in wrapper-specific guidance', () => {
      const out = call(false);

      expect(out).toContain('accepted blocking review finding');
      expect(out).not.toContain(
        'if review feedback requires only straightforward, contained edits'
      );
      expect(out).not.toContain(
        'if review fails, loop back to implementation before moving forward'
      );
    });

    it('states the blocking/non-blocking severity gate with the legacy free-text mapping', () => {
      // The gate itself is ordinary-review policy and applies in both modes.
      for (const batchMode of [false, true]) {
        const out = call(batchMode);
        expect(out).toContain('severity as a default signal');
        expect(out).toContain('not a fixed gate');
        expect(out).toContain('normally blocks');
        expect(out).toContain('normally does not');
        expect(out).toContain(
          'Record valid findings you decide are non-blocking with the `non-blocking` state'
        );
        expect(out).toContain(
          'Findings that you decide are non-blocking must NEVER by themselves trigger an implementer round or another review rerun'
        );
        expect(out).toContain(
          "reviewer's JSON output already carries a `severity` field per issue"
        );
        expect(out).toContain('use `CRITICAL`/`MAJOR` as a default blocking signal');
      }
    });

    it('carves the structural pass out of the severity gate only where a structural pass runs', () => {
      const out = call(true);
      expect(out).toContain('This gate applies to ordinary-review findings only.');
      expect(out).toContain(
        'accepting and fixing those findings, plus its single post-structural validation review, is expected and is not a gate violation'
      );
      expect(out).toContain(
        'The post-structural validation review is outside the ordinary iteration loop. Its blocking findings do not trigger an in-loop fix or another ordinary review'
      );
      expect(call(false)).not.toContain('This gate applies to ordinary-review findings only.');
    });

    it('tells the orchestrator to assign the same severities to its own review findings', () => {
      for (const batchMode of [false, true]) {
        const out = call(batchMode);
        expect(out).toContain(
          'When you perform a review yourself rather than running the reviewer command, assign one of the same four severities before making the context-based decision'
        );
        expect(out).toContain('Fix effort is not part of severity; only impact is.');
      }
    });

    it('keeps the closing-review rule inside the review budget everywhere it is stated', () => {
      for (const batchMode of [false, true]) {
        const out = call(batchMode);
        // The rule lives in one shared constant, so every site must carry the safeguard
        // that an already-full-scope terminal review is itself the closing review.
        expect(out).toContain(
          'The closing full-scope review is the last ordinary review inside the four-review budget, never an extra review.'
        );
        expect(out).toContain(
          'If the review that turns out to be terminal was already full scope, it IS the closing review: do not add another one.'
        );
      }
    });

    it('spells out the fix-verification invocation in the batch branch too', () => {
      const out = call(true);
      // The batch branch renders the shared fix-verification helper; assert its full
      // contribution so the helper cannot regress silently on this path.
      expect(out).toContain(
        'record the current commit hash with `git rev-parse HEAD` (or `jj log --no-graph -r @- -T commit_id` in a Jujutsu workspace) and then run `tim subagent reviewer 123 --print --output-file <output_path>` with `--since <that commit>` and the same full-plan scope (no `--task-index`), and enumerate in `--input` (or provide through `--input-file <paths...>`) the specific findings being re-checked.'
      );
    });

    it('gives the final full-plan sequence its own review budget', () => {
      const out = call(true);
      expect(out).toContain(
        'under its own separate four-review budget, counted independently of the orchestrator-owned per-batch reviews above'
      );
      expect(out).not.toContain('the same three tiers and four-review budget');
    });

    it('states the no-new-blocking-findings termination rule', () => {
      const out = call(false);
      expect(out).toContain(
        'targeted checks pass and a complete ordinary review produces no new blocking findings'
      );
      expect(out).toContain('a review whose only unhandled findings are non-blocking is terminal');
      expect(out).toContain('New blocking findings extend the loop');
    });

    it('triggers the cascade checkpoint on first occurrence and calls the output a consolidation proposal', () => {
      const out = call(false);
      expect(out).toContain(
        'On the FIRST review that reports the same defect class at multiple locations'
      );
      expect(out).toContain('Do not wait for a second occurrence across rounds');
      expect(out).toContain('write a concrete consolidation proposal');
      expect(out).toContain(
        'Pass the consolidation proposal and the relevant findings to the implementer as ONE consolidated instruction instead of per-instance fixes'
      );
    });

    it('never uses restructuring-proposal wording or focus-lens diversification language', () => {
      for (const batchMode of [false, true]) {
        const out = call(batchMode);
        expect(out).not.toContain('restructuring proposal');
        expect(out.toLowerCase()).not.toContain('restructur');
        expect(out.toLowerCase()).not.toContain('focus-lens');
        expect(out.toLowerCase()).not.toContain('focus lens');
        expect(out.toLowerCase()).not.toContain('perspective diversif');
      }
    });

    it('retains the 4-review bound and bounded-handoff wording', () => {
      const out = call(false);
      expect(out).toContain('Allow at most 4 ordinary review runs per task batch');
      expect(out).toContain(
        'the fourth ordinary review has completed and the bounded handoff procedure below has been completed'
      );
      expect(out).toContain(
        'After the fourth ordinary review, do not run another ordinary review as part of this iteration loop'
      );
      expect(out).toContain('create a specific follow-up task if it is worth fixing');
    });

    it('batch mode: keeps the final sequence full-plan / --since / full-plan tiers and disambiguates the structural pass', () => {
      const out = call(true);
      expect(out).toContain('Review #1 is the full-plan bookend');
      expect(out).toContain('without any `--task-index` or `--since` arguments');
      expect(out).toContain('intermediate fix-verification reruns 2..n');
      expect(out).toContain(
        'run `tim subagent reviewer 123 --print --output-file <output_path>` with `--since <that commit>` and the same full-plan scope'
      );
      expect(out).toContain(
        'The closing full-scope review is the last ordinary review inside the four-review budget, never an extra review.'
      );
      expect(out).toContain('If the bound is reached, review #4 is the closing full-scope review');
      expect(out).toContain('This gives fresh eyes twice');
      expect(out).toContain(
        'The cascade "consolidation proposal" in the Review Iteration Policy is unrelated to this standalone `--structural-only` structural pass.'
      );
      expect(out).toContain(
        'This applies to every ordinary review in this final-plan sequence, including the post-structural validation review.'
      );
      expect(out).not.toContain(
        'This applies to every review in this final-plan sequence, including the structural pass'
      );
    });

    it('batch mode: the shared review-iteration section also states the batch three-tier rule and severity gate', () => {
      const out = call(true);
      expect(out).toContain(
        'the separate final full-plan sequence follows the same three tiers under its own separate four-review budget, counted independently of the orchestrator-owned per-batch reviews above: review #1 is full-plan'
      );
      expect(out).toContain('intermediate reruns 2..n are fix-verification reviews');
      expect(out).toContain(
        'The closing full-scope review is the last ordinary review inside the four-review budget, never an extra review.'
      );
      expect(out).toContain('A `critical` or `major` finding normally blocks');
      expect(out).toContain(
        'targeted checks pass and a complete ordinary review produces no new blocking findings'
      );
    });
  });
});

describe('orchestrator_prompt structuralReviewCompleted branch (plan 398)', () => {
  const batchWrappers: Array<{
    name: string;
    planId: string;
    call: (structuralReviewCompleted?: boolean) => string;
  }> = [
    {
      name: 'wrapWithOrchestration',
      planId: '123',
      call: (structuralReviewCompleted) =>
        wrapWithOrchestration('Context', '123', {
          batchMode: true,
          planFilePath: '/tmp/x.plan.md',
          structuralReviewCompleted,
        }),
    },
    {
      name: 'wrapWithOrchestrationSimple',
      planId: '456',
      call: (structuralReviewCompleted) =>
        wrapWithOrchestrationSimple('Context', '456', {
          batchMode: true,
          planFilePath: '/tmp/x.plan.md',
          structuralReviewCompleted,
        }),
    },
    {
      name: 'wrapWithOrchestrationTdd',
      planId: '789',
      call: (structuralReviewCompleted) =>
        wrapWithOrchestrationTdd('Context', '789', {
          batchMode: true,
          simpleMode: false,
          planFilePath: '/tmp/x.plan.md',
          structuralReviewCompleted,
        }),
    },
    {
      name: 'wrapWithOrchestrationTdd (simple)',
      planId: '1011',
      call: (structuralReviewCompleted) =>
        wrapWithOrchestrationTdd('Context', '1011', {
          batchMode: true,
          simpleMode: true,
          planFilePath: '/tmp/x.plan.md',
          structuralReviewCompleted,
        }),
    },
  ];

  describe.each(batchWrappers)('$name', ({ call, planId }) => {
    it('flag set: omits the structural-pass command and states it already ran, but keeps the ordinary final-plan loop', () => {
      const out = call(true);

      const structuralCommand = `tim subagent reviewer ${planId} --print --output-file <output_path> --structural-only`;
      expect(out).not.toContain(structuralCommand);
      expect(out).not.toContain('Do not rerun the structural pass automatically.');
      expect(out).not.toContain('Resolve the structural findings you accept');
      expect(out).not.toContain(
        'This post-structural validation review is an explicit exception to the ordinary review run limit.'
      );
      expect(out).not.toContain(
        'Only after the ordinary full-plan review loop has reached a Review Iteration Policy stopping condition'
      );

      expect(out).toContain(
        'The standalone structural simplification pass has already run for this plan, so this run has no structural pass and no post-structural validation review.'
      );
      expect(out).toContain(
        'Do not run `tim subagent reviewer` with `--structural-only`, and do not improvise a substitute structural or simplification pass.'
      );
      expect(out).toContain(
        'Stop when the ordinary review loop reaches a Review Iteration Policy stopping condition.'
      );

      // The ordinary final-plan review loop text is unaffected by the flag.
      expect(out).toContain('final-plan review sequence');
      expect(out).toContain('Review #1 is the full-plan bookend');
      expect(out).toContain('without any `--task-index` or `--since` arguments');
      expect(out).toContain('intermediate fix-verification reruns 2..n');
      expect(out).toContain(
        `run \`tim subagent reviewer ${planId} --print --output-file <output_path>\` with \`--since <that commit>\``
      );
      expect(out).toContain('This gives fresh eyes twice.');
      // The addendum sentence about the post-structural exception is dropped when the
      // structural pass has already run — there is no exception left to describe.
      expect(out).not.toContain(
        'The post-structural validation review, when needed, is a separate full-plan exception after the structural pass.'
      );
      expect(out).toContain('This applies to every ordinary review in this final-plan sequence.');
      expect(out).not.toContain(
        'This applies to every ordinary review in this final-plan sequence, including the post-structural validation review.'
      );
      expect(out).toContain(
        'Any review findings related to previous tasks in this plan should still be considered'
      );

      // The shared Review Iteration Policy must not authorize structural-pass work
      // after the marker has been set.
      expect(out).not.toContain(
        'This gate applies to ordinary-review findings only. Findings from the standalone `--structural-only` structural pass'
      );
      expect(out).not.toContain(
        'The post-structural validation review is outside the ordinary iteration loop.'
      );
      expect(out).not.toContain(
        'A single ordinary review used to validate changes from the standalone structural pass is allowed in addition to this limit.'
      );
      expect(out).toContain(
        'The limit bounds iterative review execution; it does not mean that remaining feedback should be discarded.'
      );
      expect(out).not.toContain(
        'every finding from the fourth review and any post-structural validation review has been rejected'
      );
      expect(out).toContain(
        'every finding from the fourth review has been rejected or captured in a follow-up task'
      );
    });

    it('flag unset (explicit false) and flag omitted: keeps the full structural-pass sequence', () => {
      for (const out of [call(false), call(undefined)]) {
        const structuralCommand = `tim subagent reviewer ${planId} --print --output-file <output_path> --structural-only`;
        expect(out).toContain(structuralCommand);
        expect(out).toContain('Do not rerun the structural pass automatically.');
        expect(out).toContain(
          'run exactly one complete ordinary review afterward to validate the resulting plan state'
        );
        expect(out).toContain(
          'This post-structural validation review is an explicit exception to the ordinary review run limit.'
        );
        expect(out).toContain(
          'The post-structural validation review, when needed, is a separate full-plan exception after the structural pass.'
        );
        expect(out).toContain(
          'This applies to every ordinary review in this final-plan sequence, including the post-structural validation review.'
        );
        expect(out).toContain(
          'This gate applies to ordinary-review findings only. Findings from the standalone `--structural-only` structural pass'
        );
        expect(out).toContain(
          'The post-structural validation review is outside the ordinary iteration loop.'
        );
        expect(out).toContain(
          'A single ordinary review used to validate changes from the standalone structural pass is allowed in addition to this limit.'
        );
        expect(out).toContain(
          'every finding from the fourth review and any post-structural validation review has been rejected'
        );

        expect(out).not.toContain(
          'The standalone structural simplification pass has already run for this plan'
        );
      }
    });
  });

  it('non-batch mode never emits the final-batch review guidance, regardless of the flag', () => {
    for (const structuralReviewCompleted of [true, false, undefined]) {
      const outputs = [
        wrapWithOrchestration('Context', '123', { batchMode: false, structuralReviewCompleted }),
        wrapWithOrchestrationSimple('Context', '123', {
          batchMode: false,
          structuralReviewCompleted,
        }),
        wrapWithOrchestrationTdd('Context', '123', {
          batchMode: false,
          simpleMode: false,
          structuralReviewCompleted,
        }),
        wrapWithOrchestrationTdd('Context', '123', {
          batchMode: false,
          simpleMode: true,
          structuralReviewCompleted,
        }),
      ];

      for (const out of outputs) {
        expect(out).not.toContain(
          'The standalone structural simplification pass has already run for this plan'
        );
        expect(out).not.toContain(
          'tim subagent reviewer 123 --print --output-file <output_path> --structural-only'
        );
        expect(out).not.toContain('final-plan review sequence');
        expect(out).not.toContain('--structural-only');
        expect(out).not.toContain('post-structural validation review');
        expect(out).not.toContain('standalone structural simplification pass');

        const structuralReviewPolicyPhrases = [
          'This gate applies to ordinary-review findings only. Findings from the standalone `--structural-only` structural pass',
          'The post-structural validation review is outside the ordinary iteration loop.',
          'A single ordinary review used to validate changes from the standalone structural pass is allowed in addition to this limit.',
          'every finding from the fourth review and any post-structural validation review has been rejected',
        ];
        for (const phrase of structuralReviewPolicyPhrases) {
          expect(out).not.toContain(phrase);
        }
      }
    }
  });

  it('TDD wrapper: "Keep TDD order intact" sentence includes the structural-pass clause only when the flag is unset', () => {
    const structuralPassClause =
      'and the standalone `--structural-only` structural pass before stopping.';
    for (const simpleMode of [false, true]) {
      const withFlagSet = wrapWithOrchestrationTdd('Context', '789', {
        batchMode: true,
        simpleMode,
        structuralReviewCompleted: true,
      });
      expect(withFlagSet).toContain(
        'Keep TDD order intact for each iteration, including the final full-plan review loop before stopping.'
      );
      expect(withFlagSet).not.toContain(structuralPassClause);

      for (const nonBatch of [
        wrapWithOrchestrationTdd('Context', '789', {
          batchMode: false,
          simpleMode,
          structuralReviewCompleted: true,
        }),
        wrapWithOrchestrationTdd('Context', '789', {
          batchMode: false,
          simpleMode,
          structuralReviewCompleted: false,
        }),
      ]) {
        expect(nonBatch).not.toContain(structuralPassClause);
      }

      for (const withFlagUnset of [
        wrapWithOrchestrationTdd('Context', '789', {
          batchMode: true,
          simpleMode,
          structuralReviewCompleted: false,
        }),
        wrapWithOrchestrationTdd('Context', '789', { batchMode: true, simpleMode }),
      ]) {
        expect(withFlagUnset).toContain(
          `Keep TDD order intact for each iteration, including the final full-plan review loop ${structuralPassClause}`
        );
      }
    }
  });

  it.each([
    [{ batchMode: false, structuralReviewCompleted: false }, false],
    [{ batchMode: false, structuralReviewCompleted: true }, false],
    [{ batchMode: true, structuralReviewCompleted: false }, true],
    [{ batchMode: true, structuralReviewCompleted: true }, false],
  ])(
    'structuralPassApplies(%j) is %s',
    (options: { batchMode: boolean; structuralReviewCompleted: boolean }, expected: boolean) => {
      expect(structuralPassApplies(options)).toBe(expected);
    }
  );

  it('instructs passing --review-follow-up when filing follow-up tasks, in every wrapper and mode', () => {
    const outputs = [
      wrapWithOrchestration('Context', '123', { batchMode: false }),
      wrapWithOrchestration('Context', '123', { batchMode: true, planFilePath: '/plan.md' }),
      wrapWithOrchestrationSimple('Context', '123', { batchMode: false }),
      wrapWithOrchestrationTdd('Context', '123', { batchMode: false, simpleMode: false }),
    ];

    for (const out of outputs) {
      expect(out).toContain('Be careful where you file follow-up work');
      expect(out).toContain(
        'always pass `--review-follow-up` so the task is marked as review cleanup and the completed-structural-review marker is not cleared'
      );
      expect(out).toContain('tim add-task');
    }
  });
});

describe('orchestrator_prompt subagent commands', () => {
  describe('normal mode (wrapWithOrchestration)', () => {
    it('references tim subagent implementer and tester via Bash', () => {
      const out = wrapWithOrchestration('Context', '42', { batchMode: false });
      expect(out).toContain('tim subagent implementer 42');
      expect(out).toContain('tim subagent tester 42');
      expect(out).toContain('shell command tool');
      expect(out).toContain('long timeout');
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
      expect(out).toContain(
        'Prefer claude-code for frontend tasks, codex-cli for backend tasks. When choosing executors for implementer and tester, prefer using the same executor for both to maintain consistency and leverage the same strengths.'
      );
      expect(out).toContain('-x codex-cli');
      expect(out).toContain('-x claude-code');
      // Commands should not have fixed executor flag
      expect(out).not.toContain('tim subagent implementer 42 -x codex-cli');
      expect(out).not.toContain('tim subagent implementer 42 -x claude-code');
    });

    it('includes dynamic executor guidance when subagentExecutor is not set', () => {
      const out = wrapWithOrchestration('Context', '42', { batchMode: false });
      expect(out).toContain('Subagent Executor Selection');
      expect(out).toContain(
        'Prefer claude-code for frontend tasks, codex-cli for backend tasks. When choosing executors for implementer and tester, prefer using the same executor for both to maintain consistency and leverage the same strengths.'
      );
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
      expect(out).toContain('temp directory');
      expect(out).toContain('--input-file <paths...>');
      expect(out).toContain('--input-file -');
      expect(out).toContain('Prefer deterministic names');
      expect(out).toContain('/tmp/claude/tim-42-<purpose>.md');
    });
  });

  it('advertises task-index support for review-fix subagents in every wrapper', () => {
    const outputs = [
      wrapWithOrchestration('Context', '42', { batchMode: false }),
      wrapWithOrchestrationSimple('Context', '55', { batchMode: false }),
      wrapWithOrchestrationTdd('Context', '71', { batchMode: false, simpleMode: false }),
      wrapWithOrchestrationTdd('Context', '72', { batchMode: false, simpleMode: true }),
    ];

    for (const out of outputs) {
      expect(out).toContain(
        'The implementation subagents above also accept a `--task-index <indexes...>` option.'
      );
      // The advertisement line points at the policy instead of restating the
      // flag's semantics, so it cannot go stale against the reviewer option or
      // against a wrapper's agent list.
      expect(out).toContain(
        'See the Review Iteration Policy below for when to use it and what the indexes mean'
      );
      expect(out).toContain('do not infer its behavior from the reviewer option of the same name');
      expect(out).not.toContain('Every subagent command listed above');
    }
  });

  it('does not advertise a tester subagent command in simple mode, which excludes a tester', () => {
    const out = wrapWithOrchestrationSimple('Context', '55', { batchMode: false });
    expect(out).not.toContain('tim subagent tester');
    expect(out).not.toMatch(/\*\*Tester\*\*/);
    // The shared task-index guidance points at the Review Iteration Policy rather
    // than enumerating command names, so it cannot claim this wrapper offers a
    // tester. Guard against a future edit reintroducing an enumeration there.
    expect(out).not.toMatch(/tester,? (and|or) tdd-tests command/);
  });

  it('points the Iteration "Return to step" line at the policy instead of restating the rule', () => {
    const outputs = [
      wrapWithOrchestration('Context', '42', { batchMode: false }),
      wrapWithOrchestration('Context', '42', { batchMode: true, planFilePath: '/plan.md' }),
      wrapWithOrchestrationTdd('Context', '71', { batchMode: false, simpleMode: false }),
      wrapWithOrchestrationTdd('Context', '71', {
        batchMode: true,
        simpleMode: false,
        planFilePath: '/plan.md',
      }),
    ];

    for (const out of outputs) {
      expect(out).toContain(
        'If you are fixing review findings, scope the subagent command as the Review Iteration Policy directs'
      );
      // A test-only fix round is not a review-fix round, so this line must not
      // order --task-index unconditionally: the trigger above it also fires on
      // plain test failures.
      expect(out).toContain('a run that only fixes failing tests is not a review-fix round');
      expect(out).not.toContain('a fix round is scoped, unlike the initial run');
    }
  });

  it('does not add --task-index to the initial implementer/tester/tdd-tests command lines', () => {
    const outputs = [
      { out: wrapWithOrchestration('Context', '42', { batchMode: false }), planId: '42' },
      {
        out: wrapWithOrchestration('Context', '42', { batchMode: true, planFilePath: '/plan.md' }),
        planId: '42',
      },
      { out: wrapWithOrchestrationSimple('Context', '55', { batchMode: false }), planId: '55' },
      {
        out: wrapWithOrchestrationSimple('Context', '55', {
          batchMode: true,
          planFilePath: '/plan.md',
        }),
        planId: '55',
      },
      {
        out: wrapWithOrchestrationTdd('Context', '71', { batchMode: false, simpleMode: false }),
        planId: '71',
      },
      {
        out: wrapWithOrchestrationTdd('Context', '71', {
          batchMode: true,
          simpleMode: false,
          planFilePath: '/plan.md',
        }),
        planId: '71',
      },
    ];

    for (const { out, planId } of outputs) {
      expect(out).toContain(`tim subagent implementer ${planId} --input "<instructions>"`);
      // The initial implementer/tester/tdd-tests invocation lines never carry
      // --task-index: only fix-round commands the orchestrator writes itself do.
      expect(out).not.toMatch(/tim subagent (implementer|tester|tdd-tests) \S+[^\n]*--task-index/);
    }
  });

  describe('simple mode (wrapWithOrchestrationSimple)', () => {
    it('references tim subagent implementer and reviewer via Bash', () => {
      const out = wrapWithOrchestrationSimple('Context', '55', { batchMode: false });
      expect(out).toContain('tim subagent implementer 55');
      expect(out).toContain('tim subagent reviewer 55 --print');
      expect(out).toContain('shell command tool');
      expect(out).toContain('long timeout');
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
      expect(out).toContain('tim subagent reviewer 55 --print');
      expect(out).not.toContain('Subagent Executor Selection');
    });

    it('includes dynamic executor guidance when subagentExecutor is dynamic', () => {
      const out = wrapWithOrchestrationSimple('Context', '55', {
        batchMode: false,
        subagentExecutor: 'dynamic',
      });
      expect(out).toContain('Subagent Executor Selection');
      expect(out).toContain(
        'Prefer claude-code for frontend tasks, codex-cli for backend tasks. When choosing executors for implementer and tester, prefer using the same executor for both to maintain consistency and leverage the same strengths.'
      );
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
      expect(out).toContain('Prefer deterministic names');
      expect(out).toContain('/tmp/claude/tim-55-<purpose>.md');
    });

    it('includes fixed -x flag when subagentExecutor is claude-code', () => {
      const out = wrapWithOrchestrationSimple('Context', '55', {
        batchMode: false,
        subagentExecutor: 'claude-code',
      });
      expect(out).toContain('tim subagent implementer 55 -x claude-code');
      expect(out).toContain('tim subagent reviewer 55 --print');
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
      expect(out).toContain('tim subagent reviewer 71');
      expect(out).toContain('1. **TDD Test Phase**');
      expect(out).toContain('2. **Implementation Phase**');
      expect(out).toContain('3. **Testing Phase**');
      expect(out).toContain('4. **Review Phase**');
      expect(out).toContain('pass the TDD tests output');
    });

    it('allows small TDD review follow-ups without re-running implementer/reviewer', () => {
      const out = wrapWithOrchestrationTdd('Context', '71', {
        batchMode: false,
        simpleMode: false,
      });
      expect(out).toContain(
        'you may apply the changes yourself without spawning the implementer subagent'
      );
      expect(out).toContain('focused refactors');
      expect(out).toContain(
        'rerun `tim subagent reviewer 71 --print --output-file <output_path>` according to the three-tier scope rule above'
      );
    });

    it('requires a final full-plan review in batch TDD mode when all tasks are finished', () => {
      const out = wrapWithOrchestrationTdd('Context', '71', {
        batchMode: true,
        simpleMode: false,
      });
      expect(out).toContain('without any `--task-index` or `--since` arguments');
      expect(out).toContain(
        'final full-plan review loop and the standalone `--structural-only` structural pass before stopping'
      );
      expect(out).toContain('Review Iteration Policy');
    });

    it('uses reviewer in TDD simple mode', () => {
      const out = wrapWithOrchestrationTdd('Context', '72', { batchMode: false, simpleMode: true });
      expect(out).toContain('tim subagent tdd-tests 72');
      expect(out).toContain('tim subagent implementer 72');
      expect(out).toContain('tim subagent reviewer 72 --print');
      expect(out).not.toContain('tim subagent tester 72');
      expect(out).toContain('3. **Review Phase**');
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
      expect(out).toContain('tim subagent reviewer 55 --print');
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
