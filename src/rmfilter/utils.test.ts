import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { logSpawn } from '../common/process';
import { hasUncommittedChanges } from '../common/git';

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
