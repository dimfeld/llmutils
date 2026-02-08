import { describe, expect, test } from 'bun:test';
import {
  buildCommandResult,
  buildParseErrorStatus,
  buildSessionStart,
  buildTodoUpdate,
  buildUnknownStatus,
  normalizeTodoStatus,
} from './structured_message_builders.ts';

const timestamp = '2026-02-09T00:00:00.000Z';

describe('structured_message_builders', () => {
  test('normalizes todo statuses to strict enum', () => {
    expect(normalizeTodoStatus('in_progress')).toBe('in_progress');
    expect(normalizeTodoStatus('not_started')).toBe('pending');
    expect(normalizeTodoStatus('done')).toBe('completed');
    expect(normalizeTodoStatus('weird')).toBe('unknown');
  });

  test('builds todo_update payload', () => {
    const message = buildTodoUpdate('codex', timestamp, [
      { label: 'Update docs', status: 'in_progress' },
      { label: 'Unclear state', status: 'custom_value' },
    ]);

    expect(message).toEqual({
      type: 'todo_update',
      timestamp,
      source: 'codex',
      items: [
        { label: 'Update docs', status: 'in_progress' },
        { label: 'Unclear state', status: 'unknown' },
      ],
    });
  });

  test('builds command_result payload with trimmed text', () => {
    const message = buildCommandResult(timestamp, {
      command: ' bun test ',
      exitCode: 1,
      stdout: ' ok ',
      stderr: ' fail ',
    });

    expect(message).toEqual({
      type: 'command_result',
      timestamp,
      command: 'bun test',
      exitCode: 1,
      stdout: 'ok',
      stderr: 'fail',
    });
  });

  test('builds session start payload', () => {
    const message = buildSessionStart(timestamp, 'claude', {
      sessionId: 'session-1',
      threadId: 'thread-1',
    });

    expect(message).toEqual({
      type: 'agent_session_start',
      timestamp,
      executor: 'claude',
      sessionId: 'session-1',
      threadId: 'thread-1',
      tools: undefined,
      mcpServers: undefined,
    });
  });

  test('builds parse and unknown statuses', () => {
    expect(buildParseErrorStatus('claude', timestamp, 'bad-json')).toEqual({
      type: 'llm_status',
      timestamp,
      source: 'claude',
      status: 'llm.parse_error',
      detail: 'bad-json',
    });

    expect(buildUnknownStatus('codex', timestamp, 'payload', 'event')).toEqual({
      type: 'llm_status',
      timestamp,
      source: 'codex',
      status: 'llm.event',
      detail: 'payload',
    });
  });
});
