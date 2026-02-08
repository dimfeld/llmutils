import { describe, expect, test } from 'bun:test';
import { createCodexStdoutFormatter, formatCodexJsonMessage } from './format.ts';

describe('codex formatter structured mapping', () => {
  test('maps thread.started to agent_session_start with thread id', () => {
    const result = formatCodexJsonMessage(
      JSON.stringify({
        type: 'thread.started',
        thread_id: 'thread-123',
      })
    );

    expect(result.structured).toEqual(
      expect.objectContaining({
        type: 'agent_session_start',
        threadId: 'thread-123',
      })
    );
  });

  test('maps command_execution completion to command_result', () => {
    const result = formatCodexJsonMessage(
      JSON.stringify({
        type: 'item.completed',
        item: {
          item_type: 'command_execution',
          command: 'bun test',
          cwd: '/repo',
          exit_code: 2,
          stdout: 'ok',
          stderr: 'fail',
          status: 'failed',
        },
      })
    );

    expect(result.structured).toEqual(
      expect.objectContaining({
        type: 'command_result',
        command: 'bun test',
        exitCode: 2,
        stdout: 'ok',
        stderr: 'fail',
      })
    );
  });

  test('maps diff completion to file_change_summary', () => {
    const result = formatCodexJsonMessage(
      JSON.stringify({
        type: 'item.completed',
        item: {
          item_type: 'diff',
          unified_diff: ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new'].join(
            '\n'
          ),
        },
      })
    );

    expect(result.structured).toEqual(
      expect.objectContaining({
        type: 'file_change_summary',
        changes: [{ path: 'src/a.ts', kind: 'updated' }],
      })
    );
  });

  test('maps completed reasoning item to llm_thinking', () => {
    const result = formatCodexJsonMessage(
      JSON.stringify({
        type: 'item.completed',
        item: {
          item_type: 'reasoning',
          text: 'I should inspect related files first.',
        },
      })
    );

    expect(result.structured).toEqual(
      expect.objectContaining({
        type: 'llm_thinking',
        text: 'I should inspect related files first.',
      })
    );
  });

  test('maps /dev/null diff headers to added and removed file kinds', () => {
    const result = formatCodexJsonMessage(
      JSON.stringify({
        type: 'item.completed',
        item: {
          item_type: 'diff',
          unified_diff: [
            '--- /dev/null',
            '+++ b/src/new.ts',
            '@@ -0,0 +1 @@',
            '+export const value = 1;',
            '--- a/src/old.ts',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-export const removed = true;',
          ].join('\n'),
        },
      })
    );

    expect(result.structured).toEqual(
      expect.objectContaining({
        type: 'file_change_summary',
        changes: expect.arrayContaining([
          { path: 'src/new.ts', kind: 'added' },
          { path: 'src/old.ts', kind: 'removed' },
        ]),
      })
    );
  });

  test('maps diff with no files to llm_status fallback', () => {
    const result = formatCodexJsonMessage(
      JSON.stringify({
        type: 'item.completed',
        item: {
          item_type: 'diff',
          unified_diff: '',
        },
      })
    );

    expect(result.structured).toEqual(
      expect.objectContaining({
        type: 'llm_status',
        status: 'codex.diff.no_files',
      })
    );
  });

  test('maps patch apply with no changes to llm_status fallback', () => {
    const result = formatCodexJsonMessage(
      JSON.stringify({
        type: 'item.completed',
        item: {
          item_type: 'patch_apply',
          changes: {},
        },
      })
    );

    expect(result.structured).toEqual(
      expect.objectContaining({
        type: 'llm_status',
        status: 'codex.patch_apply.no_changes',
      })
    );
  });

  test('maps file_change with no changes to llm_status fallback', () => {
    const result = formatCodexJsonMessage(
      JSON.stringify({
        type: 'item.completed',
        item: {
          item_type: 'file_change',
          changes: [],
        },
      })
    );

    expect(result.structured).toEqual(
      expect.objectContaining({
        type: 'llm_status',
        status: 'codex.file_change.no_changes',
      })
    );
  });

  test('creates parse-error status for invalid json', () => {
    const result = formatCodexJsonMessage('{not-json');
    expect(result.structured).toEqual(
      expect.objectContaining({
        type: 'llm_status',
        status: 'llm.parse_error',
        source: 'codex',
      })
    );
  });

  test('maps todo_list to todo_update with structured items', () => {
    const result = formatCodexJsonMessage(
      JSON.stringify({
        type: 'item.completed',
        item: {
          item_type: 'todo_list',
          items: [{ text: 'Update docs', status: 'in_progress' }],
        },
      })
    );

    expect(result.structured).toEqual(
      expect.objectContaining({
        type: 'todo_update',
        source: 'codex',
        items: expect.arrayContaining([
          expect.objectContaining({ label: 'Update docs', status: 'in_progress' }),
        ]),
      })
    );
  });
});

describe('createCodexStdoutFormatter', () => {
  test('deduplicates repeated usage events and tracks failed agent message', () => {
    const formatter = createCodexStdoutFormatter();
    const chunk = [
      JSON.stringify({
        type: 'turn.completed',
        usage: { total_tokens: 42, input_tokens: 40, output_tokens: 2 },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { total_tokens: 42, input_tokens: 40, output_tokens: 2 },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          item_type: 'agent_message',
          text: 'FAILED: cannot continue',
        },
      }),
    ].join('\n');

    const formatted = formatter.formatChunk(`${chunk}\n`);
    expect(Array.isArray(formatted)).toBeTrue();
    expect(formatted).toHaveLength(2);
    expect((formatted as Array<{ type: string }>)[0].type).toBe('token_usage');
    expect((formatted as Array<{ type: string }>)[1].type).toBe('llm_response');
    expect(formatter.getFinalAgentMessage()).toContain('FAILED: cannot continue');
    expect(formatter.getFailedAgentMessage()).toContain('FAILED: cannot continue');
  });
});
