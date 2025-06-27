import { describe, expect, test } from 'bun:test';
import { extractCommandAfterCd } from './prefix_prompt';

describe('extractCommandAfterCd', () => {
  test('extracts command after cd && pattern', () => {
    expect(extractCommandAfterCd('cd /some/path && npm test')).toBe('npm test');
    expect(extractCommandAfterCd('cd ../dir && bun run check')).toBe('bun run check');
    expect(extractCommandAfterCd('cd path/to/dir && ls -la')).toBe('ls -la');
  });

  test('handles extra spaces around &&', () => {
    expect(extractCommandAfterCd('cd /path  &&  npm test')).toBe('npm test');
    expect(extractCommandAfterCd('cd /path&&npm test')).toBe('npm test');
    expect(extractCommandAfterCd('cd /path &&   npm test   ')).toBe('npm test');
  });

  test('returns original command when no cd && pattern', () => {
    expect(extractCommandAfterCd('npm test')).toBe('npm test');
    expect(extractCommandAfterCd('ls -la')).toBe('ls -la');
    expect(extractCommandAfterCd('cd /some/path')).toBe('cd /some/path');
  });

  test('handles paths with spaces when quoted', () => {
    expect(extractCommandAfterCd('cd "/path with spaces" && npm test')).toBe('npm test');
    expect(extractCommandAfterCd("cd '/another path/' && bun check")).toBe('bun check');
  });

  test('does not match cd in the middle of command', () => {
    expect(extractCommandAfterCd('echo cd /path && npm test')).toBe('echo cd /path && npm test');
    expect(extractCommandAfterCd('sudo cd /path && npm test')).toBe('sudo cd /path && npm test');
  });

  test('handles complex commands after &&', () => {
    expect(extractCommandAfterCd('cd /dir && npm test -- --coverage')).toBe(
      'npm test -- --coverage'
    );
    expect(extractCommandAfterCd('cd /dir && echo "hello world" | grep hello')).toBe(
      'echo "hello world" | grep hello'
    );
  });
});
