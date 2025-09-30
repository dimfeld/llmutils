import chalk from 'chalk';
import { describe, expect, it } from 'bun:test';

import { createCodexOutStdoutFormatter, formatCodexOutJsonMessage } from './format_codex_out.ts';

chalk.level = 0;

describe('formatCodexOutJsonMessage', () => {
  it('formats session.created messages', () => {
    const line = JSON.stringify({ type: 'session.created', session_id: 'abc123' });
    const result = formatCodexOutJsonMessage(line);
    expect(result.type).toBe('session.created');
    expect(result.message).toContain('Session Created');
    expect(result.message).toContain('abc123');
  });

  it('formats reasoning completion with failure detection', () => {
    const text = 'FAILED: Unable to continue';
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_1',
        item_type: 'reasoning',
        text,
      },
    });
    const result = formatCodexOutJsonMessage(line);
    expect(result.type).toBe('item.completed');
    expect(result.agentMessage).toBe(text);
    expect(result.failed).toBe(true);
    expect(result.message).toContain('Agent Message');
  });

  it('formats todo list updates', () => {
    const line = JSON.stringify({
      type: 'item.updated',
      item: {
        id: 'item_2',
        item_type: 'todo_list',
        items: [
          { text: 'First task', completed: true },
          { text: 'Second task', completed: false },
        ],
      },
    });
    const result = formatCodexOutJsonMessage(line);
    expect(result.message).toContain('Task List Update');
    expect(result.message).toContain('First task');
    expect(result.message).toContain('Second task');
  });

  it('formats command completion and includes exit code', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_3',
        item_type: 'command_execution',
        command: "bash -lc 'echo test'",
        aggregated_output: 'test\n',
        exit_code: 0,
        status: 'completed',
      },
    });
    const result = formatCodexOutJsonMessage(line);
    expect(result.message).toContain('Command End');
    expect(result.message).toContain("bash -lc 'echo test'");
    expect(result.message).toContain('Exit Code: 0');
  });

  it('falls back gracefully on unknown item types', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_4',
        item_type: 'custom_type',
        text: 'Some custom payload',
      },
    });
    const result = formatCodexOutJsonMessage(line);
    expect(result.message).toContain('custom_type');
    expect(result.message).toContain('Some custom payload');
  });

  it('returns parse_error on invalid JSON', () => {
    const result = formatCodexOutJsonMessage('not json');
    expect(result.type).toBe('parse_error');
  });
});

describe('createCodexOutStdoutFormatter', () => {
  it('captures final agent message from reasoning completion', () => {
    const { formatChunk, getFinalAgentMessage, getFailedAgentMessage } =
      createCodexOutStdoutFormatter();
    const chunk = [
      JSON.stringify({
        type: 'item.completed',
        item: { item_type: 'reasoning', text: 'All done.' },
      }),
    ].join('\n');

    const output = formatChunk(`${chunk}\n`);

    expect(output).toContain('All done.');
    expect(getFinalAgentMessage()).toBe('All done.');
    expect(getFailedAgentMessage()).toBeUndefined();
  });

  it('captures failed agent messages', () => {
    const { formatChunk, getFailedAgentMessage } = createCodexOutStdoutFormatter();
    const line = JSON.stringify({
      type: 'item.completed',
      item: { item_type: 'reasoning', text: 'FAILED: Could not apply patch' },
    });
    formatChunk(`${line}\n`);
    expect(getFailedAgentMessage()).toBe('FAILED: Could not apply patch');
  });
});
