import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as YAML from 'yaml';
import { fixYaml } from './fix_yaml';

// Suppress console output and YAML warnings during tests
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
  debug: console.debug,
};

const originalEmitWarning = process.emitWarning;

beforeAll(() => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  console.info = () => {};
  console.debug = () => {};
  // Suppress YAML library warnings
  process.emitWarning = () => {};
});

afterAll(() => {
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.info = originalConsole.info;
  console.debug = originalConsole.debug;
  process.emitWarning = originalEmitWarning;
});

describe('fixYaml', () => {
  describe('unquoted strings with colons', () => {
    test('fixes unquoted string with colon in value', async () => {
      const input = `
key: This is a value with: a colon
another_key: normal value
`;
      const result = await fixYaml(input);
      expect(result).toEqual({
        key: 'This is a value with: a colon',
        another_key: 'normal value',
      });
    });

    test('fixes multiple unquoted strings with colons', async () => {
      const input = `
key1: Value with: colon
key2: Another value: with colon
key3: normal value
`;
      const result = await fixYaml(input);
      expect(result).toEqual({
        key1: 'Value with: colon',
        key2: 'Another value: with colon',
        key3: 'normal value',
      });
    });

    test('does not quote objects or arrays', async () => {
      const input = `
object_key: { nested: value }
array_key: [1, 2, 3]
`;
      const result = await fixYaml(input);
      expect(result).toEqual({
        object_key: { nested: 'value' },
        array_key: [1, 2, 3],
      });
    });

    test('handles already quoted values with colons', async () => {
      const input = `
key1: "Already quoted: value"
key2: 'Single quoted: value'
`;
      const result = await fixYaml(input);
      expect(result).toEqual({
        key1: 'Already quoted: value',
        key2: 'Single quoted: value',
      });
    });
  });

  describe('unescaped quotes', () => {
    test('fixes unescaped double quotes in unquoted string', async () => {
      const input = `
key: This value has "quotes" inside
`;
      const result = await fixYaml(input);
      expect(result).toEqual({
        key: 'This value has "quotes" inside',
      });
    });

    test('fixes unescaped quotes in already quoted string', async () => {
      const input = `
key: "This value has "nested" quotes"
`;
      const result = await fixYaml(input);
      expect(result).toEqual({
        key: 'This value has "nested" quotes',
      });
    });

    test('handles multiple unescaped quotes', async () => {
      const input = `
key: Value with "multiple" unescaped "quotes" here
`;
      const result = await fixYaml(input);
      expect(result).toEqual({
        key: 'Value with "multiple" unescaped "quotes" here',
      });
    });

    test('preserves already escaped quotes', async () => {
      const input = `
key: "Value with \\"escaped\\" quotes"
`;
      const result = await fixYaml(input);
      expect(result).toEqual({
        key: 'Value with "escaped" quotes',
      });
    });
  });

  describe('reserved characters', () => {
    test('fixes string starting with @', async () => {
      const input = `
key: @mention in value
`;
      const result = await fixYaml(input);
      expect(result).toEqual({
        key: '@mention in value',
      });
    });

    test('fixes string starting with backtick', async () => {
      const input = `
key: \`code block\` example
`;
      const result = await fixYaml(input);
      expect(result).toEqual({
        key: '`code block` example',
      });
    });

    test('fixes strings starting with various reserved characters', async () => {
      // Only test characters that actually cause parsing errors
      const reservedChars = ['@', '`', '%', '|', '>'];
      for (const char of reservedChars) {
        const input = `key: ${char}value starting with reserved char\n
otherKey: ${char}value starting with reserved char`;
        const result = await fixYaml(input);
        expect(result).toEqual({
          key: `${char}value starting with reserved char`,
          otherKey: `${char}value starting with reserved char`,
        });
      }
    });

    test('handles YAML special characters that parse differently', async () => {
      // These characters have special meaning in YAML but don't cause errors
      expect(await fixYaml('key: #comment')).toEqual({ key: null });
      expect(await fixYaml('key: !tag value')).toEqual({ key: 'value' });
      expect(await fixYaml('key: &anchor value')).toEqual({ key: 'value' });
      // The * character would need a valid anchor reference, so it causes an error
      expect(await fixYaml('key: *invalid')).toEqual({ key: '*invalid' });
    });

    test('handles reserved characters with quotes inside', async () => {
      const input = `
key: @mention with "quotes" inside
`;
      const result = await fixYaml(input);
      expect(result).toEqual({
        key: '@mention with "quotes" inside',
      });
    });
  });

  describe('complex scenarios', () => {
    test('fixes multiple issues in same YAML', async () => {
      const input = `
title: Project: Build System
description: @mention This has "quotes" and: colons
tasks:
  - name: Task with: colon
    command: echo "hello"
  - name: @reserved char task
    status: pending
`;
      const result = await fixYaml(input);
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

    test('handles nested structures with issues', async () => {
      const input = `
outer:
  inner1: Value with: colon
  inner2: @reserved start
  inner3: Has "quotes" here
  nested:
    deep: Another: colon issue
`;
      const result = await fixYaml(input);
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

    test('fixes errors on different lines progressively', async () => {
      const input = `
line1: First: error
line2: normal value
line3: Second: error
line4: @third error
`;
      const result = await fixYaml(input);
      expect(result).toEqual({
        line1: 'First: error',
        line2: 'normal value',
        line3: 'Second: error',
        line4: '@third error',
      });
    });
  });

  describe('error handling', () => {
    test('throws after max attempts', async () => {
      // Create YAML that can't be fixed by our current logic
      const input = `
[unclosed bracket
  with: invalid nesting
    and: no closing
`;
      await expect(fixYaml(input, 3)).rejects.toThrow(
        /Failed to fix YAML after maximum attempts: /
      );
    });

    test('respects custom maxAttempts', async () => {
      const input = `
key: value with: multiple: colons: everywhere
`;
      // Should eventually fix it with enough attempts
      const result = await fixYaml(input, 10);
      expect(result).toHaveProperty('key');
    });

    test('returns valid YAML on first try', async () => {
      const input = `
key: value
nested:
  - item1
  - item2
`;
      const result = await fixYaml(input);
      expect(result).toEqual({
        key: 'value',
        nested: ['item1', 'item2'],
      });
    });
  });

  describe('edge cases', () => {
    test('handles empty YAML', async () => {
      const input = '';
      const result = await fixYaml(input);
      expect(result).toBeNull();
    });

    test('handles YAML with only comments', async () => {
      const input = `
# Just a comment
# Another comment
`;
      const result = await fixYaml(input);
      expect(result).toBeNull();
    });

    test('preserves multiline strings', async () => {
      const input = `
key: |
  This is a multiline
  string with: colons
  and "quotes"
`;
      const result = await fixYaml(input);
      expect(result).toEqual({
        key: 'This is a multiline\nstring with: colons\nand "quotes"\n',
      });
    });

    test('handles strings that look like numbers', async () => {
      const input = `
version: 1.2.3
port: 8080
`;
      const result = await fixYaml(input);
      expect(result).toEqual({
        version: '1.2.3',
        port: 8080,
      });
    });

    test('fixes issues in array items', async () => {
      const input = `
items:
  - Value with: colon
  - @reserved char
  - Has "quotes" here
`;
      const result = await fixYaml(input);
      // Note: The first item is parsed as a map because it contains a colon
      // This is valid YAML behavior, not an error
      expect(result).toEqual({
        items: [{ 'Value with': 'colon' }, '@reserved char', 'Has "quotes" here'],
      });
    });
  });

  test('fixes single line quoted strings that span lines', async () => {
    const input = `phases:
  - id: "project-1"
    tasks:
      - title: "Build Materialization Engine"
        description: "Create the core logic for populating the object_group_memberships table. This engine must handle the four key scenarios:
1.  Full materialization when an Object Group is created.
2.  Full re-materialization when an Object Group's rules are modified.
3.  Incremental evaluation for a new object against all relevant Object Groups.
4.  Incremental re-evaluation for a modified object against all relevant Object Groups."
      - title: "Implement Materialization Logging"
        description: "Create the materialization_logs table in the Drizzle schema. Integrate logging into the materialization engine to record the start, completion, duration, and outcome (success/error) of materialization tasks. This is crucial for monitoring and debugging."
    status: "pending"
`;

    const result = await fixYaml(input);
    expect(result).toEqual({
      phases: [
        {
          id: 'project-1',
          tasks: [
            {
              title: 'Build Materialization Engine',
              description: `Create the core logic for populating the object_group_memberships table. This engine must handle the four key scenarios:
1.  Full materialization when an Object Group is created.
2.  Full re-materialization when an Object Group's rules are modified.
3.  Incremental evaluation for a new object against all relevant Object Groups.
4.  Incremental re-evaluation for a modified object against all relevant Object Groups.`,
            },
            {
              title: 'Implement Materialization Logging',
              description: `Create the materialization_logs table in the Drizzle schema. Integrate logging into the materialization engine to record the start, completion, duration, and outcome (success/error) of materialization tasks. This is crucial for monitoring and debugging.`,
            },
          ],
          status: 'pending',
        },
      ],
    });
  });

  test.skip('fixed nonquoted strings that span lines with colons', async () => {
    const input = `title: Implement Multi-Organization Permissions Model
goal: To create a flexible, performant, model
details: This project will implement a new attribute-based access control (ABAC) system to complement the existing role-based access control (RBAC). The new system is designed to control access to data objects (like devices, locations, inventory) for different actors (users, teams, entire organizations).
  The core components are:
  1.  **Actor Groups**: Flexible collections of entities (users, roles, teams, organizations, other groups) that can be granted permissions.
  2.  **Object Groups**: Collections of data objects defined by a set of rules (e.g., all devices from a specific manufacturer).
  3.  **Materialized Memberships**: To ensure high performance, the members of each Object Group will be pre-calculated and stored in a dedicated table. This avoids complex, slow queries at request time.
  4.  **Permissions**: Links that grant an Actor Group access to an Object Group.
  The implementation will be phased, starting with the core backend infrastructure, followed by integration into existing queries, and finally building a comprehensive administrative UI for management.
priority: high`;

    const result = await fixYaml(input);
    expect(result).toEqual({
      title: 'Implement Multi-Organization Permissions Model',
      goal: `To create a flexible, performant, model`,
      details: `This project will implement a new attribute-based access control (ABAC) system to complement the existing role-based access control (RBAC). The new system is designed to control access to data objects (like devices, locations, inventory) for different actors (users, teams, entire organizations).
  The core components are:
  1.  **Actor Groups**: Flexible collections of entities (users, roles, teams, organizations, other groups) that can be granted permissions.
  2.  **Object Groups**: Collections of data objects defined by a set of rules (e.g., all devices from a specific manufacturer).
  3.  **Materialized Memberships**: To ensure high performance, the members of each Object Group will be pre-calculated and stored in a dedicated table. This avoids complex, slow queries at request time.
  4.  **Permissions**: Links that grant an Actor Group access to an Object Group.
  The implementation will be phased, starting with the core backend infrastructure, followed by integration into existing queries, and finally building a comprehensive administrative UI for management.`,
      priority: 'high',
    });
  });

  describe('attempt counter reset', () => {
    test('resets attempt counter when error moves to later line', async () => {
      // This tests the logic where attempt counter resets if error line increases
      const input = `
key1: First: error here
key2: Second: error here
key3: Third: error here
key4: Fourth: error here
key5: Fifth: error here
`;
      // Should be able to fix all errors even if there are many
      const result = await fixYaml(input, 5);
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
