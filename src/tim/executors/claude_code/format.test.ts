import { test, describe, expect, beforeEach } from 'bun:test';
import { formatJsonMessage, resetToolUseCache } from './format.ts';

describe('formatJsonMessage', () => {
  beforeEach(() => {
    resetToolUseCache();
  });

  describe('file path extraction', () => {
    test('extracts file_path from Write tool invocation', () => {
      const writeMessage = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool1',
              name: 'Write',
              input: {
                file_path: '/test/file.ts',
                content: 'console.log("hello");\nconsole.log("world");',
              },
            },
          ],
        },
        session_id: 'test-session',
      });

      const result = formatJsonMessage(writeMessage);
      expect(result.filePaths).toEqual(['/test/file.ts']);
      expect(result.message).toContain('/test/file.ts');
      expect(result.message).toContain('(2 lines)');
    });

    test('extracts file_path from Edit tool invocation', () => {
      const editMessage = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool2',
              name: 'Edit',
              input: {
                file_path: '/src/utils.ts',
                old_string: 'const x = 1;',
                new_string: 'const x = 2;',
              },
            },
          ],
        },
        session_id: 'test-session',
      });

      const result = formatJsonMessage(editMessage);
      expect(result.filePaths).toEqual(['/src/utils.ts']);
      expect(result.message).toContain('/src/utils.ts');
      expect(result.message).toContain('const x = 1');
      expect(result.message).toContain('const x = 2');
    });

    test('extracts file_path from MultiEdit tool invocation', () => {
      const multiEditMessage = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool3',
              name: 'MultiEdit',
              input: {
                file_path: '/components/Button.tsx',
                edits: [
                  {
                    old_string: 'className="btn"',
                    new_string: 'className="btn primary"',
                  },
                ],
              },
            },
          ],
        },
        session_id: 'test-session',
      });

      const result = formatJsonMessage(multiEditMessage);
      expect(result.filePaths).toEqual(['/components/Button.tsx']);
      expect(result.message).toContain('MultiEdit');
    });

    test('returns empty filePaths array for tools without file_path', () => {
      const bashMessage = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool4',
              name: 'Bash',
              input: {
                command: 'ls -la',
              },
            },
          ],
        },
        session_id: 'test-session',
      });

      const result = formatJsonMessage(bashMessage);
      expect(result.filePaths).toBeUndefined();
      expect(result.message).toContain('Bash');
    });

    test('returns empty object for debug messages', () => {
      const debugMessage = '[DEBUG] Some debug information';
      const result = formatJsonMessage(debugMessage);
      expect(result).toEqual({ type: '' });
    });

    test('returns parse error status for malformed JSON', () => {
      const result = formatJsonMessage('not-json');
      expect(result.type).toBe('parse_error');
      expect(result.structured).toEqual({
        type: 'llm_status',
        status: 'llm.parse_error',
        source: 'claude',
        detail: 'not-json',
        timestamp: expect.any(String),
      });
    });

    test('handles multiple tool invocations with mixed file operations', () => {
      const mixedMessage = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool1',
              name: 'Write',
              input: {
                file_path: '/test/first.ts',
                content: 'export const first = 1;',
              },
            },
            {
              type: 'tool_use',
              id: 'tool2',
              name: 'Bash',
              input: {
                command: 'npm test',
              },
            },
            {
              type: 'tool_use',
              id: 'tool3',
              name: 'Edit',
              input: {
                file_path: '/test/second.ts',
                old_string: 'const old = true;',
                new_string: 'const new = false;',
              },
            },
          ],
        },
        session_id: 'test-session',
      });

      const result = formatJsonMessage(mixedMessage);
      expect(result.filePaths).toEqual(['/test/first.ts', '/test/second.ts']);
    });

    test('handles missing file_path in Write tool gracefully', () => {
      const incompleteWriteMessage = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool1',
              name: 'Write',
              input: {
                content: 'some content',
                // missing file_path
              },
            },
          ],
        },
        session_id: 'test-session',
      });

      const result = formatJsonMessage(incompleteWriteMessage);
      expect(result.filePaths).toBeUndefined();
      expect(result.message).toContain('Write');
    });

    test('handles missing file_path in Edit tool gracefully', () => {
      const incompleteEditMessage = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool2',
              name: 'Edit',
              input: {
                old_string: 'old',
                new_string: 'new',
                // missing file_path
              },
            },
          ],
        },
        session_id: 'test-session',
      });

      const result = formatJsonMessage(incompleteEditMessage);
      expect(result.filePaths).toBeUndefined();
      expect(result.message).toContain('Edit');
    });

    test('handles missing file_path in MultiEdit tool gracefully', () => {
      const incompleteMultiEditMessage = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool3',
              name: 'MultiEdit',
              input: {
                edits: [
                  {
                    old_string: 'old',
                    new_string: 'new',
                  },
                ],
                // missing file_path
              },
            },
          ],
        },
        session_id: 'test-session',
      });

      const result = formatJsonMessage(incompleteMultiEditMessage);
      expect(result.filePaths).toBeUndefined();
      expect(result.message).toContain('MultiEdit');
    });

    test('handles null or undefined input gracefully', () => {
      const nullInputMessage = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool1',
              name: 'Write',
              input: null,
            },
          ],
        },
        session_id: 'test-session',
      });

      const result = formatJsonMessage(nullInputMessage);
      expect(result.filePaths).toBeUndefined();
      expect(result.message).toContain('Write');
    });

    test('handles empty content array', () => {
      const emptyContentMessage = JSON.stringify({
        type: 'assistant',
        message: {
          content: [],
        },
        session_id: 'test-session',
      });

      const result = formatJsonMessage(emptyContentMessage);
      expect(result.filePaths).toBeUndefined();
    });

    test('handles string content in message', () => {
      const stringContentMessage = JSON.stringify({
        type: 'assistant',
        message: {
          content: ['This is a simple text message'],
        },
        session_id: 'test-session',
      });

      const result = formatJsonMessage(stringContentMessage);
      expect(result.filePaths).toBeUndefined();
      expect(result.message).toContain('This is a simple text message');
    });

    test('handles result messages without file paths', () => {
      const resultMessage = JSON.stringify({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.05,
        duration_ms: 5000,
        duration_api_ms: 2000,
        is_error: false,
        num_turns: 3,
        result: 'Task completed successfully',
        session_id: 'test-session',
      });

      const result = formatJsonMessage(resultMessage);
      expect(result.filePaths).toBeUndefined();
      expect(result.message).toContain('Cost: $0.05');
      expect(result.message).toContain('Turns: 3');
    });

    test('handles system init messages without file paths', () => {
      const systemMessage = JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'test-session',
        tools: ['Write', 'Edit', 'Read'],
        mcp_servers: [],
      });

      const result = formatJsonMessage(systemMessage);
      expect(result.filePaths).toBeUndefined();
      expect(result.message).toContain('Starting');
    });

    test('extracts relative file paths correctly', () => {
      const relativePathMessage = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool1',
              name: 'Write',
              input: {
                file_path: 'src/relative/path.ts',
                content: 'export const relative = true;',
              },
            },
          ],
        },
        session_id: 'test-session',
      });

      const result = formatJsonMessage(relativePathMessage);
      expect(result.filePaths).toEqual(['src/relative/path.ts']);
    });

    test('handles special characters in file paths', () => {
      const specialPathMessage = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool1',
              name: 'Edit',
              input: {
                file_path: '/test/path with spaces/file-name_123.ts',
                old_string: 'old',
                new_string: 'new',
              },
            },
          ],
        },
        session_id: 'test-session',
      });

      const result = formatJsonMessage(specialPathMessage);
      expect(result.filePaths).toEqual(['/test/path with spaces/file-name_123.ts']);
    });
  });

  describe('return type structure', () => {
    test('returns object with message and filePaths properties', () => {
      const writeMessage = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool1',
              name: 'Write',
              input: {
                file_path: '/test.ts',
                content: 'test',
              },
            },
          ],
        },
        session_id: 'test-session',
      });

      const result = formatJsonMessage(writeMessage);
      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('filePaths');
      expect(typeof result.message).toBe('string');
      expect(Array.isArray(result.filePaths)).toBe(true);
    });

    test('returns object with only message property when no file paths', () => {
      const bashMessage = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool1',
              name: 'Bash',
              input: {
                command: 'echo hello',
              },
            },
          ],
        },
        session_id: 'test-session',
      });

      const result = formatJsonMessage(bashMessage);
      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('message');
      expect(result.filePaths).toBeUndefined();
    });

    test('returns empty object for debug messages', () => {
      const result = formatJsonMessage('[DEBUG] debug info');
      expect(result).toEqual({ type: '' });
    });
  });

  describe('system message handling', () => {
    test('handles task_notification messages', () => {
      const taskNotificationMessage = JSON.stringify({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'bff49b0',
        status: 'completed',
        output_file: '/private/tmp/claude/tasks/bff49b0.output',
        summary: 'Background command "Final review for Tasks 22 and 27" completed (exit code 0)',
        session_id: 'test-session',
      });

      const result = formatJsonMessage(taskNotificationMessage);
      expect(result.message).toContain('task_notification');
      expect(result.message).toContain('bff49b0');
      expect(result.message).toContain('completed');
      expect(result.message).toContain('Background command');
      expect(result.type).toBe('system');
    });

    test('handles status messages with compacting status', () => {
      const statusMessage = JSON.stringify({
        type: 'system',
        subtype: 'status',
        status: 'compacting',
        session_id: 'test-session',
      });

      const result = formatJsonMessage(statusMessage);
      expect(result.message).toContain('Status');
      expect(result.message).toContain('compacting');
      expect(result.type).toBe('system');
    });

    test('ignores status messages with null status', () => {
      const nullStatusMessage = JSON.stringify({
        type: 'system',
        subtype: 'status',
        status: null,
        session_id: 'test-session',
      });

      const result = formatJsonMessage(nullStatusMessage);
      expect(result.type).toBe('');
      expect(result.message).toBeUndefined();
    });

    test('handles compact_boundary messages', () => {
      const compactBoundaryMessage = JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 'test-session',
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: 156423,
        },
      });

      const result = formatJsonMessage(compactBoundaryMessage);
      expect(result.message).toContain('Compacting');
      expect(result.message).toContain('auto');
      expect(result.message).toContain('156423 tokens');
      expect(result.type).toBe('system');
    });
  });

  describe('structured payload mapping', () => {
    test('maps successful result to agent_session_end', () => {
      const resultLine = JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 'session-1',
        total_cost_usd: 0.25,
        duration_ms: 1234,
        duration_api_ms: 1000,
        is_error: false,
        num_turns: 7,
        result: 'done',
      });

      const result = formatJsonMessage(resultLine);
      expect(result.structured).toEqual(
        expect.objectContaining({
          type: 'agent_session_end',
          sessionId: 'session-1',
          success: true,
          costUsd: 0.25,
          durationMs: 1234,
          turns: 7,
        })
      );
    });

    test('maps Write tool_use to file_write with line count', () => {
      const message = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool1',
              name: 'Write',
              input: {
                file_path: '/tmp/test.ts',
                content: 'line1\nline2\nline3',
              },
            },
          ],
        },
        session_id: 's',
      });

      const result = formatJsonMessage(message);
      expect(result.filePaths).toEqual(['/tmp/test.ts']);
      expect(Array.isArray(result.structured)).toBeTrue();
      expect(result.structured).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'file_write',
            path: '/tmp/test.ts',
            lineCount: 3,
          }),
        ])
      );
    });

    test('maps Bash tool_result to command_result', () => {
      const message = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-bash',
              name: 'Bash',
              input: { command: 'pwd' },
            },
            {
              type: 'tool_result',
              tool_use_id: 'tool-bash',
              content: {
                command: 'pwd',
                stdout: '/repo\n',
                stderr: '',
                exit_code: 0,
              },
            },
          ],
        },
        session_id: 's',
      });

      const result = formatJsonMessage(message);
      expect(Array.isArray(result.structured)).toBeTrue();
      expect(result.structured).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'command_result',
            command: 'pwd',
            exitCode: 0,
            stdout: '/repo',
          }),
        ])
      );
    });

    test('maps TodoWrite to todo_update with structured items', () => {
      const message = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-todo',
              name: 'TodoWrite',
              input: {
                todos: [{ id: '1', content: 'Ship fix', status: 'in_progress', priority: 'high' }],
              },
            },
          ],
        },
        session_id: 's',
      });

      const result = formatJsonMessage(message);
      expect(Array.isArray(result.structured)).toBeTrue();
      expect(result.structured).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'todo_update',
            source: 'claude',
            items: expect.arrayContaining([
              expect.objectContaining({
                label: 'Ship fix',
                status: 'in_progress',
              }),
            ]),
          }),
        ])
      );
    });

    test('handles malformed TodoWrite todos payload without throwing', () => {
      const message = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-todo',
              name: 'TodoWrite',
              input: {
                todos: 'not-an-array',
              },
            },
          ],
        },
        session_id: 's',
      });

      const result = formatJsonMessage(message);
      expect(Array.isArray(result.structured)).toBeTrue();
      expect(result.structured).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'llm_tool_use',
            toolName: 'TodoWrite',
          }),
        ])
      );
    });
  });
});
