import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { getRemoteTrunkBranch } from '$common/git.js';
import { finishProjectChat, remoteProjectChatBranchExists } from './project_chat_finish.js';

const chatId = '11111111-1111-4111-8111-111111111111';
const branch = `chat/${chatId}`;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

describe('finishProjectChat', () => {
  let root: string;
  let remote: string;
  let primary: string;
  const originalPath = process.env.PATH;

  beforeEach(async (): Promise<void> => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-project-chat-finish-test-'));
    remote = path.join(root, 'origin.git');
    primary = path.join(root, 'primary');
    git(root, 'init', '--bare', '--initial-branch=main', remote);
    git(root, 'clone', remote, primary);
    git(primary, 'config', 'user.name', 'Test User');
    git(primary, 'config', 'user.email', 'test@example.com');
    await fs.writeFile(path.join(primary, 'work.txt'), 'base\n');
    git(primary, 'add', 'work.txt');
    git(primary, 'commit', '-m', 'Base');
    git(primary, 'push', '-u', 'origin', 'main');
  });

  afterEach(async (): Promise<void> => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await fs.rm(root, { recursive: true, force: true });
  });

  async function pushChatChange(text: string): Promise<void> {
    git(primary, 'switch', '-c', branch);
    await fs.writeFile(path.join(primary, 'chat.txt'), text);
    git(primary, 'add', 'chat.txt');
    git(primary, 'commit', '-m', 'Chat change');
    git(primary, 'push', '-u', 'origin', branch);
    git(primary, 'switch', 'main');
  }

  test('finds origin trunk and leaves an unused chat branch absent', async (): Promise<void> => {
    expect(await getRemoteTrunkBranch(primary)).toBe('main');
    expect(await remoteProjectChatBranchExists(primary, branch)).toBe(false);
  });

  test('rebases and fast-forward pushes trunk-based chat work', async (): Promise<void> => {
    await pushChatChange('chat work\n');
    await fs.writeFile(path.join(primary, 'trunk.txt'), 'new trunk work\n');
    git(primary, 'add', 'trunk.txt');
    git(primary, 'commit', '-m', 'Move trunk');
    git(primary, 'push', 'origin', 'main');

    expect(
      await finishProjectChat({
        cwd: primary,
        branch,
        trunk: 'main',
        chatId,
        workflow: 'trunk-based',
        summary: 'Chat work',
      })
    ).toEqual({ status: 'integrated', branch: 'main' });
    expect(git(root, '--git-dir', remote, 'show', 'main:chat.txt')).toBe('chat work');
    expect(git(root, '--git-dir', remote, 'show', 'main:trunk.txt')).toBe('new trunk work');
    expect(await remoteProjectChatBranchExists(primary, branch)).toBe(true);
  });

  test('creates a PR for pr-based chat work', async (): Promise<void> => {
    await pushChatChange('chat work\n');
    const binDir = path.join(root, 'bin');
    await fs.mkdir(binDir);
    const ghPath = path.join(binDir, 'gh');
    await fs.writeFile(
      ghPath,
      '#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi\nif [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "https://example.com/pr/1"; exit 0; fi\nexit 1\n'
    );
    await fs.chmod(ghPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;

    expect(
      await finishProjectChat({
        cwd: primary,
        branch,
        trunk: 'main',
        chatId,
        workflow: 'pr-based',
        summary: 'Chat work',
      })
    ).toEqual({ status: 'pr', url: 'https://example.com/pr/1' });
    expect(git(root, '--git-dir', remote, 'show', 'main:work.txt')).toBe('base');
  });

  test('squashes chat commits and recognizes a completed finish', async (): Promise<void> => {
    await pushChatChange('first\n');
    git(primary, 'switch', branch);
    await fs.writeFile(path.join(primary, 'second.txt'), 'second\n');
    git(primary, 'add', 'second.txt');
    git(primary, 'commit', '-m', 'Second change');
    git(primary, 'push', 'origin', branch);
    git(primary, 'switch', 'main');

    const input = {
      cwd: primary,
      branch,
      trunk: 'main',
      chatId,
      workflow: 'squash-rebase' as const,
      summary: 'Finish chat work',
    };
    expect(await finishProjectChat(input)).toEqual({ status: 'integrated', branch: 'main' });
    expect(git(root, '--git-dir', remote, 'log', 'main', '-1', '--format=%B')).toContain(
      `Project-Chat-Id: ${chatId}`
    );
    expect(git(root, '--git-dir', remote, 'rev-list', '--count', 'main')).toBe('2');
    expect(await finishProjectChat(input)).toEqual({
      status: 'already_integrated',
      branch: 'main',
    });
  });

  test('keeps both remote branches when rebase conflicts', async (): Promise<void> => {
    git(primary, 'switch', '-c', branch);
    await fs.writeFile(path.join(primary, 'work.txt'), 'chat version\n');
    git(primary, 'add', 'work.txt');
    git(primary, 'commit', '-m', 'Chat change');
    git(primary, 'push', '-u', 'origin', branch);
    git(primary, 'switch', 'main');
    await fs.writeFile(path.join(primary, 'work.txt'), 'trunk version\n');
    git(primary, 'add', 'work.txt');
    git(primary, 'commit', '-m', 'Trunk change');
    git(primary, 'push', 'origin', 'main');

    await expect(
      finishProjectChat({
        cwd: primary,
        branch,
        trunk: 'main',
        chatId,
        workflow: 'trunk-based',
        summary: 'Chat work',
      })
    ).rejects.toThrow();
    expect(git(root, '--git-dir', remote, 'show', 'main:work.txt')).toBe('trunk version');
    expect(git(root, '--git-dir', remote, 'show', `${branch}:work.txt`)).toBe('chat version');
  });
});
