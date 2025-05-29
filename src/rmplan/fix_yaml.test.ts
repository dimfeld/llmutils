import { describe, expect, test } from 'bun:test';
import * as YAML from 'yaml';
import { fixYaml } from './fix_yaml';

describe('fixYaml', () => {
  describe('unquoted strings with colons', () => {
    test('fixes unquoted string with colon in value', () => {
      const input = `
key: This is a value with: a colon
another_key: normal value
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        key: 'This is a value with: a colon',
        another_key: 'normal value',
      });
    });

    test('fixes multiple unquoted strings with colons', () => {
      const input = `
key1: Value with: colon
key2: Another value: with colon
key3: normal value
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        key1: 'Value with: colon',
        key2: 'Another value: with colon',
        key3: 'normal value',
      });
    });

    test('does not quote objects or arrays', () => {
      const input = `
object_key: { nested: value }
array_key: [1, 2, 3]
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        object_key: { nested: 'value' },
        array_key: [1, 2, 3],
      });
    });

    test('handles already quoted values with colons', () => {
      const input = `
key1: "Already quoted: value"
key2: 'Single quoted: value'
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        key1: 'Already quoted: value',
        key2: 'Single quoted: value',
      });
    });
  });

  describe('unescaped quotes', () => {
    test('fixes unescaped double quotes in unquoted string', () => {
      const input = `
key: This value has "quotes" inside
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        key: 'This value has "quotes" inside',
      });
    });

    test('fixes unescaped quotes in already quoted string', () => {
      const input = `
key: "This value has "nested" quotes"
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        key: 'This value has "nested" quotes',
      });
    });

    test('handles multiple unescaped quotes', () => {
      const input = `
key: Value with "multiple" unescaped "quotes" here
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        key: 'Value with "multiple" unescaped "quotes" here',
      });
    });

    test('preserves already escaped quotes', () => {
      const input = `
key: "Value with \\"escaped\\" quotes"
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        key: 'Value with "escaped" quotes',
      });
    });
  });

  describe('reserved characters', () => {
    test('fixes string starting with @', () => {
      const input = `
key: @mention in value
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        key: '@mention in value',
      });
    });

    test('fixes string starting with backtick', () => {
      const input = `
key: \`code block\` example
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        key: '`code block` example',
      });
    });

    test('fixes strings starting with various reserved characters', () => {
      // Only test characters that actually cause parsing errors
      const reservedChars = ['@', '`', '%', '|', '>'];
      for (const char of reservedChars) {
        const input = `key: ${char}value starting with reserved char\n
otherKey: ${char}value starting with reserved char`;
        const result = fixYaml(input);
        expect(result).toEqual({
          key: `${char}value starting with reserved char`,
          otherKey: `${char}value starting with reserved char`,
        });
      }
    });

    test('handles YAML special characters that parse differently', () => {
      // These characters have special meaning in YAML but don't cause errors
      expect(fixYaml('key: #comment')).toEqual({ key: null });
      expect(fixYaml('key: !tag value')).toEqual({ key: 'value' });
      expect(fixYaml('key: &anchor value')).toEqual({ key: 'value' });
      // The * character would need a valid anchor reference, so it causes an error
      expect(fixYaml('key: *invalid')).toEqual({ key: '*invalid' });
    });

    test('handles reserved characters with quotes inside', () => {
      const input = `
key: @mention with "quotes" inside
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        key: '@mention with "quotes" inside',
      });
    });
  });

  describe('complex scenarios', () => {
    test('fixes multiple issues in same YAML', () => {
      const input = `
title: Project: Build System
description: @mention This has "quotes" and: colons
tasks:
  - name: Task with: colon
    command: echo "hello"
  - name: @reserved char task
    status: pending
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        title: 'Project: Build System',
        description: '@mention This has "quotes" and: colons',
        tasks: [
          {
            name: 'Task with: colon',
            command: 'echo "hello"',
          },
          {
            name: '@reserved char task',
            status: 'pending',
          },
        ],
      });
    });

    test('handles nested structures with issues', () => {
      const input = `
outer:
  inner1: Value with: colon
  inner2: @reserved start
  inner3: Has "quotes" here
  nested:
    deep: Another: colon issue
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        outer: {
          inner1: 'Value with: colon',
          inner2: '@reserved start',
          inner3: 'Has "quotes" here',
          nested: {
            deep: 'Another: colon issue',
          },
        },
      });
    });

    test('fixes errors on different lines progressively', () => {
      const input = `
line1: First: error
line2: normal value
line3: Second: error
line4: @third error
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        line1: 'First: error',
        line2: 'normal value',
        line3: 'Second: error',
        line4: '@third error',
      });
    });
  });

  describe('error handling', () => {
    test('throws after max attempts', () => {
      // Create YAML that can't be fixed by our current logic
      const input = `
[unclosed bracket
  with: invalid nesting
    and: no closing
`;
      expect(() => fixYaml(input, 3)).toThrow('Failed to fix YAML after maximum attempts.');
    });

    test('respects custom maxAttempts', () => {
      const input = `
key: value with: multiple: colons: everywhere
`;
      // Should eventually fix it with enough attempts
      const result = fixYaml(input, 10);
      expect(result).toHaveProperty('key');
    });

    test('returns valid YAML on first try', () => {
      const input = `
key: value
nested:
  - item1
  - item2
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        key: 'value',
        nested: ['item1', 'item2'],
      });
    });
  });

  describe('edge cases', () => {
    test('handles empty YAML', () => {
      const input = '';
      const result = fixYaml(input);
      expect(result).toBeNull();
    });

    test('handles YAML with only comments', () => {
      const input = `
# Just a comment
# Another comment
`;
      const result = fixYaml(input);
      expect(result).toBeNull();
    });

    test('preserves multiline strings', () => {
      const input = `
key: |
  This is a multiline
  string with: colons
  and "quotes"
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        key: 'This is a multiline\nstring with: colons\nand "quotes"\n',
      });
    });

    test('handles strings that look like numbers', () => {
      const input = `
version: 1.2.3
port: 8080
`;
      const result = fixYaml(input);
      expect(result).toEqual({
        version: '1.2.3',
        port: 8080,
      });
    });

    test('fixes issues in array items', () => {
      const input = `
items:
  - Value with: colon
  - @reserved char
  - Has "quotes" here
`;
      const result = fixYaml(input);
      // Note: The first item is parsed as a map because it contains a colon
      // This is valid YAML behavior, not an error
      expect(result).toEqual({
        items: [{ 'Value with': 'colon' }, '@reserved char', 'Has "quotes" here'],
      });
    });
  });

  describe('attempt counter reset', () => {
    test('resets attempt counter when error moves to later line', () => {
      // This tests the logic where attempt counter resets if error line increases
      const input = `
key1: First: error here
key2: Second: error here
key3: Third: error here
key4: Fourth: error here
key5: Fifth: error here
`;
      // Should be able to fix all errors even if there are many
      const result = fixYaml(input, 5);
      expect(result).toEqual({
        key1: 'First: error here',
        key2: 'Second: error here',
        key3: 'Third: error here',
        key4: 'Fourth: error here',
        key5: 'Fifth: error here',
      });
    });
  });
});
