import { describe, expect, test } from 'vitest';

import type { StructuredMessagePayload } from '$lib/types/session.js';

import { formatStructuredMessage, getDisplayCategory } from './message_formatting.js';

describe('message_formatting', () => {
  test('getDisplayCategory maps structured message types to display categories', () => {
    const cases: Array<[StructuredMessagePayload, string]> = [
      [{ type: 'agent_session_start' }, 'lifecycle'],
      [{ type: 'agent_session_end', success: true }, 'lifecycle'],
      [{ type: 'agent_iteration_start', iterationNumber: 1 }, 'lifecycle'],
      [{ type: 'agent_step_start', phase: 'implement' }, 'lifecycle'],
      [{ type: 'agent_step_end', phase: 'implement', success: true }, 'lifecycle'],
      [{ type: 'review_start' }, 'lifecycle'],
      [{ type: 'input_required' }, 'lifecycle'],
      [
        {
          type: 'prompt_request',
          requestId: 'req-1',
          promptType: 'confirm',
          promptConfig: { message: 'Continue?' },
        },
        'lifecycle',
      ],
      [
        {
          type: 'prompt_answered',
          requestId: 'req-1',
          promptType: 'confirm',
          source: 'terminal',
        },
        'lifecycle',
      ],
      [{ type: 'plan_discovery', planId: 253, title: 'Structured messages' }, 'lifecycle'],
      [{ type: 'workspace_info', path: '/tmp/ws' }, 'lifecycle'],
      [{ type: 'execution_summary', summary: baseExecutionSummary() }, 'lifecycle'],
      [{ type: 'llm_thinking', text: 'thinking' }, 'llmOutput'],
      [{ type: 'llm_response', text: 'response' }, 'llmOutput'],
      [{ type: 'llm_tool_use', toolName: 'search' }, 'toolUse'],
      [{ type: 'llm_tool_result', toolName: 'search' }, 'toolUse'],
      [{ type: 'file_write', path: 'a.ts', lineCount: 1 }, 'fileChange'],
      [{ type: 'file_edit', path: 'a.ts', diff: '+ test' }, 'fileChange'],
      [{ type: 'file_change_summary', changes: [] }, 'fileChange'],
      [{ type: 'command_exec', command: 'bun run test' }, 'command'],
      [{ type: 'command_result', exitCode: 0 }, 'command'],
      [{ type: 'llm_status', status: 'running' }, 'progress'],
      [{ type: 'todo_update', items: [] }, 'progress'],
      [{ type: 'task_completion', planComplete: false }, 'progress'],
      [{ type: 'workflow_progress', message: 'working' }, 'progress'],
      [{ type: 'token_usage', totalTokens: 12 }, 'progress'],
      [{ type: 'failure_report', summary: 'Failed' }, 'error'],
      [
        {
          type: 'review_result',
          verdict: 'NEEDS_FIXES',
          issues: [],
          recommendations: [],
          actionItems: [],
        },
        'error',
      ],
      [
        {
          type: 'review_result',
          verdict: 'ACCEPTABLE',
          issues: [],
          recommendations: [],
          actionItems: [],
        },
        'lifecycle',
      ],
      [{ type: 'user_terminal_input', content: 'y' }, 'userInput'],
    ];

    for (const [message, expected] of cases) {
      expect(getDisplayCategory(message)).toBe(expected);
    }
  });

  test('formats agent session start messages like the legacy server formatter', () => {
    expect(
      formatStructuredMessage({
        type: 'agent_session_start',
        executor: 'codex',
        mode: 'agent',
        planId: 253,
      })
    ).toEqual({
      type: 'text',
      text: 'Agent session started | executor=codex | mode=agent | plan=253',
    });
  });

  test('formats llm_tool_use with key-value entries and pretty-printed JSON', () => {
    expect(
      formatStructuredMessage({
        type: 'llm_tool_use',
        toolName: 'search_query',
        inputSummary: 'Find plan',
        input: { query: 'plan 253', limit: 5 },
      })
    ).toEqual({
      type: 'keyValuePairs',
      entries: [
        { key: 'Tool', value: 'search_query' },
        { key: 'Summary', value: 'Find plan' },
        { key: 'Input', value: '{\n  "query": "plan 253",\n  "limit": 5\n}' },
      ],
    });
  });

  test('formats command_result with command, exit code, cwd, stdout, and stderr sections', () => {
    expect(
      formatStructuredMessage({
        type: 'command_result',
        command: 'bun run test-web',
        cwd: '/repo',
        exitCode: 1,
        stdout: 'stdout text',
        stderr: 'stderr text',
      })
    ).toEqual({
      type: 'monospaced',
      text: '$ bun run test-web\n\nexit 1\n\ncwd: /repo\n\nstdout:\nstdout text\n\nstderr:\nstderr text',
    });
  });

  test('formats token_usage with console-style rate limit details', () => {
    expect(
      formatStructuredMessage({
        type: 'token_usage',
        inputTokens: 1683626,
        cachedInputTokens: 1579136,
        outputTokens: 15328,
        reasoningTokens: 11327,
        totalTokens: 1698954,
        rateLimits: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: 1, windowDurationMins: 300 },
            secondary: { usedPercent: 1, windowDurationMins: 10080 },
          },
        },
      })
    ).toEqual({
      type: 'text',
      text: [
        'input=1683626 cached=1579136 output=15328 reasoning=11327 total=1698954',
        'rateLimits=codex: primary 1%/300m, secondary 1%/10080m',
      ].join('\n'),
    });
  });

  test('formats todo_update by preserving structured items and explanation', () => {
    expect(
      formatStructuredMessage({
        type: 'todo_update',
        items: [
          { label: 'Investigate failures', status: 'completed' },
          { label: 'Add formatter tests', status: 'in_progress' },
        ],
        explanation: 'Working through the remaining gaps',
      })
    ).toEqual({
      type: 'todoList',
      items: [
        { label: 'Investigate failures', status: 'completed' },
        { label: 'Add formatter tests', status: 'in_progress' },
      ],
      explanation: 'Working through the remaining gaps',
    });
  });

  test('formats file_change_summary for the existing file-changes renderer', () => {
    expect(
      formatStructuredMessage({
        type: 'file_change_summary',
        changes: [
          { path: 'src/lib/utils/message_formatting.ts', kind: 'updated' },
          { path: 'src/lib/utils/message_formatting.test.ts', kind: 'added' },
        ],
        status: 'completed',
      })
    ).toEqual({
      type: 'fileChanges',
      changes: [
        { path: 'src/lib/utils/message_formatting.ts', kind: 'updated' },
        { path: 'src/lib/utils/message_formatting.test.ts', kind: 'added' },
      ],
      status: 'completed',
    });
  });

  test('formats execution_summary with newline-separated changed files and errors', () => {
    expect(
      formatStructuredMessage({
        type: 'execution_summary',
        summary: {
          ...baseExecutionSummary(),
          changedFiles: ['src/a.ts', 'src/b.ts'],
          errors: ['First error', 'Second error'],
        },
      })
    ).toEqual({
      type: 'keyValuePairs',
      entries: [
        { key: 'Plan ID', value: '253' },
        { key: 'Plan Title', value: 'Structured messages' },
        { key: 'Mode', value: 'serial' },
        { key: 'Duration', value: '456' },
        { key: 'Changed Files', value: 'src/a.ts\nsrc/b.ts' },
        { key: 'Errors', value: 'First error\nSecond error' },
      ],
    });
  });

  test('formats prompt_answered using the legacy value serialization', () => {
    expect(
      formatStructuredMessage({
        type: 'prompt_answered',
        requestId: 'req-1',
        promptType: 'checkbox',
        source: 'websocket',
        value: ['tests', 'check'],
      })
    ).toEqual({
      type: 'text',
      text: 'Prompt answered: checkbox | websocket | [\n  "tests",\n  "check"\n]',
    });
  });

  test('returns null for review_result so the client can use a rich renderer', () => {
    expect(
      formatStructuredMessage({
        type: 'review_result',
        verdict: 'NEEDS_FIXES',
        fixInstructions: 'Resolve the reported issues.',
        issues: [
          {
            severity: 'major',
            category: 'correctness',
            content: 'Structured review messages should stay rich on the client.',
          },
        ],
        recommendations: ['Add a dedicated component'],
        actionItems: ['Write client formatting tests'],
      })
    ).toBeNull();
  });
});

function baseExecutionSummary() {
  return {
    planId: '253',
    planTitle: 'Structured messages',
    planFilePath: 'tasks/253-web-use-structured-data-for-client-side-messages.plan.md',
    mode: 'serial' as const,
    startedAt: '2026-03-23T08:00:00.000Z',
    durationMs: 456,
    steps: [],
    changedFiles: [],
    errors: [],
    metadata: {
      totalSteps: 1,
      failedSteps: 0,
    },
  };
}
