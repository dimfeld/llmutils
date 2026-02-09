import { describe, expect, it } from 'bun:test';
import { formatStructuredMessage } from './console_formatter.ts';
import type { StructuredMessage } from './structured_messages.ts';

function format(message: StructuredMessage): string {
  return formatStructuredMessage(message);
}

describe('console_formatter', () => {
  const timestamp = '2026-02-08T01:02:03.000Z';

  it('formats lifecycle messages', () => {
    const start = format({
      type: 'agent_session_start',
      timestamp,
      executor: 'codex',
      planId: 168,
    });
    expect(start).toContain('Starting');
    expect(start).toContain(timestamp);
    expect(start).toContain('codex');
    expect(start).toContain('168');

    const end = format({ type: 'agent_session_end', timestamp, success: true, costUsd: 0.05 });
    expect(end).toContain('Success');
    expect(end).toContain('yes');
    expect(end).toContain('Cost: $0.05');
    const failedEnd = format({ type: 'agent_session_end', timestamp, success: false });
    expect(failedEnd).toContain('Success');
    expect(failedEnd).toContain('no');

    const iteration = format({
      type: 'agent_iteration_start',
      timestamp,
      iterationNumber: 2,
      taskTitle: 'Task',
    });
    expect(iteration).toContain('Iteration 2');
    expect(iteration).toContain('Task');

    const stepStart = format({
      type: 'agent_step_start',
      timestamp,
      phase: 'reviewer',
      message: 'Running reviewer step...',
    });
    expect(stepStart).toContain('Step Start: reviewer');
    expect(stepStart).toContain('Running reviewer step...');

    const stepEnd = format({
      type: 'agent_step_end',
      timestamp,
      phase: 'reviewer',
      success: true,
      summary: 'Reviewer output captured.',
    });
    expect(stepEnd).toContain('Step End: reviewer');
    expect(stepEnd).toContain('Reviewer output captured.');
  });

  it('formats llm and tool messages', () => {
    expect(format({ type: 'llm_thinking', timestamp, text: 'hmm' })).toContain('Thinking');
    expect(format({ type: 'llm_response', timestamp, text: 'done' })).toContain('Model Response');
    expect(format({ type: 'llm_tool_use', timestamp, toolName: 'Write' })).toContain('Invoke Tool');
    expect(format({ type: 'llm_tool_result', timestamp, toolName: 'Write' })).toContain(
      'Tool Result'
    );
    expect(format({ type: 'llm_status', timestamp, status: 'compacting' })).toContain('compacting');
    const todo = format({
      type: 'todo_update',
      timestamp,
      items: [
        { label: 'Wire parser', status: 'in_progress' },
        { label: 'Ship tests', status: 'pending' },
      ],
    });
    expect(todo).toContain('Todo Update');
    expect(todo).toContain('Wire parser');
    expect(todo).toContain('Ship tests');
  });

  it('formats file and command messages', () => {
    const fileWrite = format({ type: 'file_write', timestamp, path: 'src/a.ts', lineCount: 2 });
    expect(fileWrite).toContain('src/a.ts');
    expect(fileWrite).toContain('2 lines');

    const fileEdit = format({
      type: 'file_edit',
      timestamp,
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@\n-old\n+new',
    });
    expect(fileEdit).toContain('src/a.ts');
    expect(fileEdit).toContain('@@ -1 +1 @@');
    expect(fileEdit).toContain('-old');
    expect(fileEdit).toContain('+new');

    const fileChangeSummary = format({
      type: 'file_change_summary',
      timestamp,
      changes: [
        { path: 'a.ts', kind: 'added' },
        { path: 'b.ts', kind: 'updated' },
        { path: 'c.ts', kind: 'removed' },
      ],
    });
    expect(fileChangeSummary).toContain('File Changes');
    expect(fileChangeSummary).toContain('a.ts');
    expect(fileChangeSummary).toContain('b.ts');
    expect(fileChangeSummary).toContain('c.ts');

    const commandExec = format({ type: 'command_exec', timestamp, command: 'bun test' });
    expect(commandExec).toContain('Exec Begin');
    expect(commandExec).toContain('bun test');

    const commandResult = format({
      type: 'command_result',
      timestamp,
      command: 'bun test',
      cwd: '/tmp/project',
      exitCode: 1,
      stderr: 'fail',
    });
    expect(commandResult).toContain('Exit Code: 1');
    expect(commandResult).toContain('bun test');
    expect(commandResult).toContain('/tmp/project');
    expect(commandResult).toContain('fail');
    expect(commandResult.match(/bun test/g)?.length).toBe(1);
  });

  it('formats review and workflow messages', () => {
    expect(format({ type: 'review_start', timestamp, executor: 'claude' })).toContain(
      'Executing Review'
    );
    const reviewResult = format({
      type: 'review_result',
      timestamp,
      issues: [
        {
          severity: 'minor',
          category: 'style',
          content: 'Fix style',
          file: 'src/a.ts',
          line: '2',
          suggestion: 'Format',
        },
      ],
      recommendations: ['run format'],
      actionItems: ['fix style'],
    });
    expect(reviewResult).toBe('');
    expect(format({ type: 'review_verdict', timestamp, verdict: 'ACCEPTABLE' })).toBe('');
    expect(
      format({ type: 'workflow_progress', timestamp, message: 'Generating', phase: 'context' })
    ).toContain('Generating');
    expect(format({ type: 'failure_report', timestamp, summary: 'failed badly' })).toContain(
      'FAILED'
    );
    expect(format({ type: 'task_completion', timestamp, planComplete: true })).toContain(
      'Task complete'
    );
  });

  it('formats summary and misc messages', () => {
    const executionSummary = format({
      type: 'execution_summary',
      timestamp,
      summary: {
        planId: '168',
        planTitle: 'Structured Logging',
        planFilePath: 'tasks/168.plan.md',
        mode: 'serial',
        startedAt: timestamp,
        endedAt: timestamp,
        durationMs: 1234,
        steps: [],
        changedFiles: [],
        errors: [],
        metadata: { totalSteps: 1, failedSteps: 0 },
      },
    });
    expect(executionSummary).toContain('Execution Summary');
    expect(executionSummary).toContain('Structured Logging');
    expect(executionSummary).toContain('Plan ID');
    expect(executionSummary).toContain('168');
    expect(executionSummary).toContain('Duration');
    expect(executionSummary).toContain('1s');
    expect(executionSummary).toContain('Started');
    expect(executionSummary).toContain('Ended');
    expect(executionSummary).toContain('File Changes');
    expect(executionSummary).toContain('Completed plan 168');
    expect(format({ type: 'token_usage', timestamp, totalTokens: 12 })).toContain('Usage');
    expect(format({ type: 'input_required', timestamp, prompt: 'Choose' })).toContain(
      'Input required'
    );
    expect(format({ type: 'plan_discovery', timestamp, planId: 1, title: 'Plan' })).toContain(
      'Found ready plan'
    );
    expect(format({ type: 'workspace_info', timestamp, path: '/tmp/ws' })).toContain('/tmp/ws');
  });

  it('formats failed execution summaries with failure completion line', () => {
    const failedExecutionSummary = format({
      type: 'execution_summary',
      timestamp,
      summary: {
        planId: '168',
        planTitle: 'Structured Logging',
        planFilePath: 'tasks/168.plan.md',
        mode: 'serial',
        startedAt: timestamp,
        endedAt: timestamp,
        durationMs: 1234,
        steps: [],
        changedFiles: [],
        errors: ['reviewer step failed'],
        metadata: { totalSteps: 1, failedSteps: 1 },
      },
    });

    expect(failedExecutionSummary).toContain('Execution Summary');
    expect(failedExecutionSummary).toContain('Failed Steps');
    expect(failedExecutionSummary).toContain('1');
    expect(failedExecutionSummary).toContain('Execution finished for plan 168');
    expect(failedExecutionSummary).not.toContain('Completed plan 168');
  });

  it('formats token usage with only provided fields', () => {
    const emptyUsage = format({ type: 'token_usage', timestamp });
    expect(emptyUsage).toContain('Usage');
    expect(emptyUsage).not.toContain('input=0');
    expect(emptyUsage).not.toContain('total=0');

    const populatedUsage = format({
      type: 'token_usage',
      timestamp,
      inputTokens: 5,
      totalTokens: 9,
    });
    expect(populatedUsage).toContain('input=5');
    expect(populatedUsage).toContain('total=9');
    expect(populatedUsage).not.toContain('cached=');
  });

  it('returns empty output for input_required without prompt', () => {
    expect(format({ type: 'input_required', timestamp })).toBe('');
  });
});
