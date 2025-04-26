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
