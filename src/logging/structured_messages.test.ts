import { describe, expect, it } from 'bun:test';
import {
  structuredMessageTypeList,
  type ReviewVerdict,
  type StructuredMessage,
  type UserTerminalInputMessage,
} from './structured_messages.ts';

const summaryFixture = {
  planId: '168',
  planTitle: 'Structured Logging',
  planFilePath: 'tasks/168.plan.md',
  mode: 'serial' as const,
  startedAt: '2026-02-08T00:00:00.000Z',
  endedAt: '2026-02-08T00:10:00.000Z',
  durationMs: 600000,
  steps: [],
  changedFiles: ['src/logging/structured_messages.ts'],
  errors: [],
  metadata: {
    totalSteps: 1,
    failedSteps: 0,
  },
};

describe('structured_messages', () => {
  it('supports all expected structured message variants', () => {
    const timestamp = '2026-02-08T00:00:00.000Z';
    const messages: StructuredMessage[] = [
      { type: 'agent_session_start', timestamp, executor: 'claude' },
      { type: 'agent_session_end', timestamp, success: true },
      { type: 'agent_iteration_start', timestamp, iterationNumber: 1 },
      { type: 'agent_step_start', timestamp, phase: 'implementer' },
      { type: 'agent_step_end', timestamp, phase: 'implementer', success: true },
      { type: 'llm_thinking', timestamp, text: 'thinking' },
      { type: 'llm_response', timestamp, text: 'response' },
      { type: 'llm_tool_use', timestamp, toolName: 'Write' },
      { type: 'llm_tool_result', timestamp, toolName: 'Write' },
      { type: 'llm_status', timestamp, status: 'compacting' },
      { type: 'todo_update', timestamp, items: [{ label: 'Ship it', status: 'in_progress' }] },
      { type: 'file_write', timestamp, path: 'src/a.ts', lineCount: 3 },
      { type: 'file_edit', timestamp, path: 'src/a.ts', diff: '@@' },
      { type: 'file_change_summary', timestamp, changes: [{ path: 'src/a.ts', kind: 'updated' }] },
      { type: 'command_exec', timestamp, command: 'bun test' },
      { type: 'command_result', timestamp, exitCode: 0 },
      { type: 'review_start', timestamp, executor: 'codex' },
      {
        type: 'review_result',
        timestamp,
        verdict: 'NEEDS_FIXES',
        fixInstructions: 'Fix bug',
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'Bug found',
            file: 'src/file.ts',
            line: '10',
            suggestion: 'Fix it',
          },
        ],
        recommendations: ['Add tests'],
        actionItems: ['Fix bug'],
      },
      { type: 'workflow_progress', timestamp, message: 'Running review' },
      { type: 'failure_report', timestamp, summary: 'Failed' },
      { type: 'task_completion', timestamp, planComplete: false },
      { type: 'execution_summary', timestamp, summary: summaryFixture },
      { type: 'token_usage', timestamp, totalTokens: 123 },
      { type: 'input_required', timestamp, prompt: 'Confirm' },
      { type: 'user_terminal_input', timestamp, content: 'Please add tests', source: 'terminal' },
      {
        type: 'prompt_request',
        timestamp,
        requestId: 'test-id',
        promptType: 'confirm',
        promptConfig: { message: 'Continue?' },
      },
      {
        type: 'prompt_answered',
        timestamp,
        requestId: 'test-id',
        promptType: 'confirm',
        value: true,
        source: 'terminal',
      },
      { type: 'plan_discovery', timestamp, planId: 1, title: 'Plan' },
      { type: 'workspace_info', timestamp, path: '/tmp/ws' },
    ];

    expect(new Set(messages.map((message) => message.type))).toEqual(
      new Set(structuredMessageTypeList)
    );
  });

  it('round-trips as JSON', () => {
    const message: StructuredMessage = {
      type: 'command_result',
      timestamp: '2026-02-08T00:00:00.000Z',
      command: 'bun test',
      exitCode: 0,
      stdout: 'ok',
    };

    const parsed = JSON.parse(JSON.stringify(message)) as StructuredMessage;
    expect(parsed).toEqual(message);
  });

  it('round-trips nested execution summary payloads as JSON', () => {
    const message: StructuredMessage = {
      type: 'execution_summary',
      timestamp: '2026-02-08T00:00:00.000Z',
      summary: summaryFixture,
    };

    const parsed = JSON.parse(JSON.stringify(message)) as StructuredMessage;
    expect(parsed).toEqual(message);
  });

  it('includes user_terminal_input in the public message type list', () => {
    expect(structuredMessageTypeList).toContain('user_terminal_input');
  });

  it('does not include legacy review_verdict in the public message type list', () => {
    expect(structuredMessageTypeList).not.toContain('review_verdict');
  });

  it('exposes ReviewVerdict and requires verdict on review_result messages', () => {
    const verdict: ReviewVerdict = 'ACCEPTABLE';
    const message: Extract<StructuredMessage, { type: 'review_result' }> = {
      type: 'review_result',
      timestamp: '2026-02-08T00:00:00.000Z',
      verdict,
      issues: [],
      recommendations: [],
      actionItems: [],
    };

    expect(message.verdict).toBe('ACCEPTABLE');
  });

  it('supports user_terminal_input message shape', () => {
    const message: UserTerminalInputMessage = {
      type: 'user_terminal_input',
      timestamp: '2026-02-08T00:00:00.000Z',
      content: 'Also fix the type error',
      source: 'gui',
    };

    const asStructured: StructuredMessage = message;
    expect(asStructured.type).toBe('user_terminal_input');
    expect((asStructured as UserTerminalInputMessage).content).toBe('Also fix the type error');
    expect((asStructured as UserTerminalInputMessage).source).toBe('gui');
  });
});
