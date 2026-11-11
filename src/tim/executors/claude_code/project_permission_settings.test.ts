import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadClaudeProjectPermissionSettings } from './project_permission_settings.js';

describe('loadClaudeProjectPermissionSettings', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-project-perms-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeSettings(fileName: string, content: unknown): Promise<void> {
    await fs.mkdir(path.join(tempDir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, '.claude', fileName),
      typeof content === 'string' ? content : JSON.stringify(content)
    );
  }

  it('returns undefined when there is no .claude directory', async () => {
    expect(await loadClaudeProjectPermissionSettings(tempDir)).toBeUndefined();
  });

  it('returns undefined when the settings have no permission rules', async () => {
    await writeSettings('settings.json', { env: { FOO: '1' }, permissions: { allow: [] } });
    expect(await loadClaudeProjectPermissionSettings(tempDir)).toBeUndefined();
  });

  it('merges allow, ask, and deny rules from both files and removes duplicates', async () => {
    await writeSettings('settings.json', {
      permissions: { allow: ['Bash(ls)', 'Read'], deny: ['Bash(rm:*)'], defaultMode: 'plan' },
      hooks: { PreToolUse: [] },
    });
    await writeSettings('settings.local.json', {
      permissions: { allow: ['Bash(ls)', 'Bash(git status)'], ask: ['WebFetch'] },
    });

    const result = await loadClaudeProjectPermissionSettings(tempDir);
    expect(JSON.parse(result!)).toEqual({
      permissions: {
        allow: ['Bash(ls)', 'Read', 'Bash(git status)'],
        ask: ['WebFetch'],
        deny: ['Bash(rm:*)'],
      },
    });
  });

  it('skips a file with invalid JSON and still reads the other file', async () => {
    await writeSettings('settings.json', '{not json');
    await writeSettings('settings.local.json', { permissions: { allow: ['Bash(ls)'] } });

    const result = await loadClaudeProjectPermissionSettings(tempDir);
    expect(JSON.parse(result!)).toEqual({ permissions: { allow: ['Bash(ls)'] } });
  });

  it('ignores entries that are not non-empty strings', async () => {
    await writeSettings('settings.json', {
      permissions: { allow: ['Bash(ls)', 5, '', null], deny: 'Bash(rm)' },
    });

    const result = await loadClaudeProjectPermissionSettings(tempDir);
    expect(JSON.parse(result!)).toEqual({ permissions: { allow: ['Bash(ls)'] } });
  });
});
