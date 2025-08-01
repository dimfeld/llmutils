import { test, describe, expect } from 'bun:test';
import { formatJsonMessage } from './format.ts';

describe('formatJsonMessage', () => {
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
      expect(result.message).toContain('File path: /test/file.ts');
      expect(result.message).toContain('Number of lines: 2');
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
      expect(result.message).toContain('File path: /src/utils.ts');
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
      expect(result.message).toContain('file_path: /components/Button.tsx');
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
      expect(result).toEqual({});
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
      expect(result.message).toContain('5s for 3 turns');
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
      expect(result.message).toContain('Tools: Write, Edit, Read');
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
      expect(result).toEqual({});
    });
  });
});
