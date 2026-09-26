import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { getRemoteTrunkBranch } from '$common/git.js';
import { remoteProjectChatBranchExists } from './project_chat_finish.js';

const chatId = '11111111-1111-4111-8111-111111111111';
const branch = `chat/${chatId}`;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

describe('remoteProjectChatBranchExists', () => {
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

  test('finds a pushed chat branch', async (): Promise<void> => {
    await pushChatChange('chat work\n');
    expect(await remoteProjectChatBranchExists(primary, branch)).toBe(true);
  });
});
