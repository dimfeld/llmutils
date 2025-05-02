import { describe, expect, it } from 'bun:test';
import * as path from 'node:path';
import { validatePath } from './utils';

describe('validatePath', () => {
  const baseDir = '/home/user/project';

  it('should return absolute path for valid relative path within base directory', () => {
    const relativePath = 'src/file.txt';
    const expected = path.resolve(baseDir, relativePath);
    const result = validatePath(baseDir, relativePath);
    expect(result).toBe(expected);
  });

  it('should allow operations on the base directory itself', () => {
    const relativePath = '.';
    const expected = path.resolve(baseDir);
    const result = validatePath(baseDir, relativePath);
    expect(result).toBe(expected);
  });

  it('should handle nested paths correctly', () => {
    const relativePath = 'src/nested/deep/file.txt';
    const expected = path.resolve(baseDir, relativePath);
    const result = validatePath(baseDir, relativePath);
    expect(result).toBe(expected);
  });

  it('should throw error for path traversal attempts', () => {
    const relativePath = '../outside.txt';
    expect(() => validatePath(baseDir, relativePath)).toThrow(
      `Security Error: Attempted file operation outside of the base directory "${path.resolve(baseDir)}"`
    );
  });

  it('should throw error for absolute path outside base directory', () => {
    const relativePath = '/home/other/file.txt';
    expect(() => validatePath(baseDir, relativePath)).toThrow(
      `Security Error: Attempted file operation outside of the base directory "${path.resolve(baseDir)}"`
    );
  });

  it('should handle complex path with dot and dot-dot', () => {
    const relativePath = 'src/./nested/../file.txt';
    const expected = path.resolve(baseDir, 'src/file.txt');
    const result = validatePath(baseDir, relativePath);
    expect(result).toBe(expected);
  });

  it('should throw error for path attempting to escape with multiple dot-dot', () => {
    const relativePath = '../../../etc/passwd';
    expect(() => validatePath(baseDir, relativePath)).toThrow(
      `Security Error: Attempted file operation outside of the base directory "${path.resolve(baseDir)}"`
    );
  });
});
import { describe, expect, it } from 'bun:test';
import { parseCliArgsFromString } from './utils';

describe('parseCliArgsFromString', () => {
  it('should parse simple arguments without quotes', () => {
    const input = 'arg1 arg2 arg3';
    const expected = ['arg1', 'arg2', 'arg3'];
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
    const input = 'arg1 "double quoted" \'single quoted\' arg4 --flag="value"';
    const expected = ['arg1', 'double quoted', 'single quoted', 'arg4', '--flag=value'];
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
    const input = 'arg1 * ? | > < arg2="val*?"';
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
