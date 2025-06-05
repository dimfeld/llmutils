import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { logSpawn } from './utils';
import { hasUncommittedChanges } from '../common/git';
import { parseCliArgsFromString } from './utils';


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

describe('hasUncommittedChanges', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-git-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return false for a clean git repository', async () => {
    // Initialize a git repo
    await logSpawn(['git', 'init'], { cwd: tempDir }).exited;
    await logSpawn(['git', 'config', 'user.email', 'test@example.com'], { cwd: tempDir }).exited;
    await logSpawn(['git', 'config', 'user.name', 'Test User'], { cwd: tempDir }).exited;

    // Create a file and commit it
    const testFile = path.join(tempDir, 'test.txt');
    await fs.writeFile(testFile, 'initial content');
    await logSpawn(['git', 'add', '.'], { cwd: tempDir }).exited;
    await logSpawn(['git', 'commit', '-m', 'Initial commit'], { cwd: tempDir }).exited;

    const hasChanges = await hasUncommittedChanges(tempDir);
    expect(hasChanges).toBe(false);
  });

  it('should return true for uncommitted changes in working directory', async () => {
    // Initialize a git repo
    await logSpawn(['git', 'init'], { cwd: tempDir }).exited;
    await logSpawn(['git', 'config', 'user.email', 'test@example.com'], { cwd: tempDir }).exited;
    await logSpawn(['git', 'config', 'user.name', 'Test User'], { cwd: tempDir }).exited;

    // Create and commit initial file
    const testFile = path.join(tempDir, 'test.txt');
    await fs.writeFile(testFile, 'initial content');
    await logSpawn(['git', 'add', '.'], { cwd: tempDir }).exited;
    await logSpawn(['git', 'commit', '-m', 'Initial commit'], { cwd: tempDir }).exited;

    // Make changes without committing
    await fs.writeFile(testFile, 'modified content');

    const hasChanges = await hasUncommittedChanges(tempDir);
    expect(hasChanges).toBe(true);
  });

  it('should return true for staged changes', async () => {
    // Initialize a git repo
    await logSpawn(['git', 'init'], { cwd: tempDir }).exited;
    await logSpawn(['git', 'config', 'user.email', 'test@example.com'], { cwd: tempDir }).exited;
    await logSpawn(['git', 'config', 'user.name', 'Test User'], { cwd: tempDir }).exited;

    // Create and commit initial file
    const testFile = path.join(tempDir, 'test.txt');
    await fs.writeFile(testFile, 'initial content');
    await logSpawn(['git', 'add', '.'], { cwd: tempDir }).exited;
    await logSpawn(['git', 'commit', '-m', 'Initial commit'], { cwd: tempDir }).exited;

    // Stage a new file
    const newFile = path.join(tempDir, 'new.txt');
    await fs.writeFile(newFile, 'new content');
    await logSpawn(['git', 'add', newFile], { cwd: tempDir }).exited;

    const hasChanges = await hasUncommittedChanges(tempDir);
    expect(hasChanges).toBe(true);
  });
});
