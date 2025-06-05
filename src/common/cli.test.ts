import { describe, expect, it } from 'bun:test';
import { parseCliArgsFromString } from './cli';

describe('parseCliArgsFromString', () => {
  it('should parse simple arguments without quotes', () => {
    const input = 'arg1 arg2 arg3';
    const expected = ['arg1', 'arg2', 'arg3'];
    expect(parseCliArgsFromString(input)).toEqual(expected);
  });

  it('should parse arguments with equals signs correctly', () => {
    const input = '--example-file TERM=src/file.ts';
    const expected = ['--example-file', 'TERM=src/file.ts'];
    expect(parseCliArgsFromString(input)).toEqual(expected);
  });

  it('should parse arguments with double quotes', () => {
    const input = 'arg1 "arg 2 with spaces" arg3';
    const expected = ['arg1', 'arg 2 with spaces', 'arg3'];
    expect(parseCliArgsFromString(input)).toEqual(expected);
  });

  it('should parse arguments with single quotes', () => {
    const input = "arg1 'arg 2 with spaces' arg3";
    const expected = ['arg1', 'arg 2 with spaces', 'arg3'];
    expect(parseCliArgsFromString(input)).toEqual(expected);
  });

  it('should handle escaped double quotes inside double-quoted strings', () => {
    const input = 'arg1 "arg \\"with quotes\\" inside" arg3';
    const expected = ['arg1', 'arg "with quotes" inside', 'arg3'];
    expect(parseCliArgsFromString(input)).toEqual(expected);
  });

  it('should handle escaped single quotes inside single-quoted strings', () => {
    const input = "arg1 'arg \\'with quotes\\' inside' arg3";
    const expected = ['arg1', "arg 'with quotes' inside", 'arg3'];
    expect(parseCliArgsFromString(input)).toEqual(expected);
  });

  it('should handle escaped backslashes inside quoted strings', () => {
    const input = 'arg1 "path\\\\to\\\\file" arg3';
    const expected = ['arg1', 'path\\to\\file', 'arg3'];
    expect(parseCliArgsFromString(input)).toEqual(expected);
  });

  it('should handle mixed quoted and unquoted arguments', () => {
    const input = 'arg1 "double quoted" \'single quoted\' arg4';
    const expected = ['arg1', 'double quoted', 'single quoted', 'arg4'];
    expect(parseCliArgsFromString(input)).toEqual(expected);
  });

  it('should return an empty array for an empty string input', () => {
    const input = '';
    const expected: string[] = [];
    expect(parseCliArgsFromString(input)).toEqual(expected);
  });

  it('should return an empty array for a string with only whitespace', () => {
    const input = '   \t  \n ';
    const expected: string[] = [];
    expect(parseCliArgsFromString(input)).toEqual(expected);
  });

  it('should handle arguments with special characters', () => {
    const input = 'arg1 * ? | > < arg2=val*?';
    const expected = ['arg1', '*', '?', '|', '>', '<', 'arg2=val*?'];
    expect(parseCliArgsFromString(input)).toEqual(expected);
  });

  it('should preserve leading/trailing whitespace within quotes', () => {
    const input = '"  leading space" "trailing space  "';
    const expected = ['  leading space', 'trailing space  '];
    expect(parseCliArgsFromString(input)).toEqual(expected);
  });

  it('should handle arguments separated by multiple spaces', () => {
    const input = 'arg1   arg2  "arg 3"';
    const expected = ['arg1', 'arg2', 'arg 3'];
    expect(parseCliArgsFromString(input)).toEqual(expected);
  });
});
