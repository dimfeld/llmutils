import { describe, expect, test } from 'bun:test';
import { MentionParser } from './mention_parser';

describe('MentionParser', () => {
  const parser = new MentionParser('mybot');

  test('parses simple command', () => {
    const result = parser.parse('@mybot rmplan generate');
    expect(result).toEqual({
      command: 'rmplan',
      args: ['generate'],
      options: {},
      contextFiles: undefined,
    });
  });

  test('parses command with options', () => {
    const result = parser.parse('@mybot rmfilter --with-imports --instructions "Fix the bug"');
    expect(result).toEqual({
      command: 'rmfilter',
      args: [],
      options: {
        'with-imports': true,
        instructions: 'Fix the bug',
      },
      contextFiles: undefined,
    });
  });

  test('parses command with context files', () => {
    const result = parser.parse('@mybot rmplan generate --plan tasks/feature.md -- src/**/*.ts');
    expect(result).toEqual({
      command: 'rmplan',
      args: ['generate'],
      options: {
        plan: 'tasks/feature.md',
      },
      contextFiles: ['src/**/*.ts'],
    });
  });

  test('parses command with mixed arguments', () => {
    const result = parser.parse('@mybot rmrun --model gpt-4 --dry-run src/main.ts');
    expect(result).toEqual({
      command: 'rmrun',
      args: ['src/main.ts'],
      options: {
        model: 'gpt-4',
        'dry-run': true,
      },
      contextFiles: undefined,
    });
  });

  test('handles quoted strings', () => {
    const result = parser.parse(
      '@mybot rmfilter --instructions "This is a \\"quoted\\" string" file.ts'
    );
    expect(result).toEqual({
      command: 'rmfilter',
      args: ['file.ts'],
      options: {
        instructions: 'This is a "quoted" string',
      },
      contextFiles: undefined,
    });
  });

  test('handles single quotes', () => {
    const result = parser.parse("@mybot rmfilter --instructions 'Single quoted' file.ts");
    expect(result).toEqual({
      command: 'rmfilter',
      args: ['file.ts'],
      options: {
        instructions: 'Single quoted',
      },
      contextFiles: undefined,
    });
  });

  test('returns null for non-mention', () => {
    const result = parser.parse('Just a regular comment');
    expect(result).toBeNull();
  });

  test('returns null for mention without command', () => {
    const result = parser.parse('@mybot');
    expect(result).toBeNull();
  });

  test('is case insensitive for bot name', () => {
    const result = parser.parse('@MyBot rmplan generate');
    expect(result).toEqual({
      command: 'rmplan',
      args: ['generate'],
      options: {},
      contextFiles: undefined,
    });
  });

  test('handles short options', () => {
    const result = parser.parse('@mybot rmfilter -v -d file.ts');
    expect(result).toEqual({
      command: 'rmfilter',
      args: ['file.ts'],
      options: {
        v: true,
        d: true,
      },
      contextFiles: undefined,
    });
  });

  test('handles equals sign in options', () => {
    const result = parser.parse('@mybot rmrun --model=gpt-4 --temperature=0.7');
    expect(result).toEqual({
      command: 'rmrun',
      args: [],
      options: {
        model: 'gpt-4',
        temperature: '0.7',
      },
      contextFiles: undefined,
    });
  });

  test('handles multiple context files after --', () => {
    const result = parser.parse('@mybot rmplan next -- src/main.ts src/utils.ts src/**/*.test.ts');
    expect(result).toEqual({
      command: 'rmplan',
      args: ['next'],
      options: {},
      contextFiles: ['src/main.ts', 'src/utils.ts', 'src/**/*.test.ts'],
    });
  });

  test('handles whitespace correctly', () => {
    const result = parser.parse('  @mybot   rmplan   generate   --plan   "My Plan"  ');
    expect(result).toEqual({
      command: 'rmplan',
      args: ['generate'],
      options: {
        plan: 'My Plan',
      },
      contextFiles: undefined,
    });
  });
});
