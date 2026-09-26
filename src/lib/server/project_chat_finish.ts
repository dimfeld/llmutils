import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export type ProjectChatWorkflow = 'pr-based' | 'trunk-based' | 'squash-rebase';

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], cwd: string): Promise<CommandResult> {
  const proc = Bun.spawn(args, {
    cwd,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function required(args: string[], cwd: string): Promise<string> {
  const result = await run(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `${args[0]} ${args[1]} failed (exit ${result.exitCode})`);
  }
  return result.stdout;
}

export async function remoteProjectChatBranchExists(cwd: string, branch: string): Promise<boolean> {
  const result = await run(['git', 'ls-remote', '--exit-code', '--heads', 'origin', branch], cwd);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 2) return false;
  throw new Error(result.stderr || 'Could not check the chat branch on origin');
}

export interface FinishProjectChatInput {
  cwd: string;
  branch: string;
  trunk: string;
  chatId: string;
  workflow: ProjectChatWorkflow;
  summary: string;
}

export type FinishProjectChatResult =
  | { status: 'pr'; url: string }
  | { status: 'integrated'; branch: string }
  | { status: 'already_integrated'; branch: string };

export async function finishProjectChat(
  input: FinishProjectChatInput
): Promise<FinishProjectChatResult> {
  if (!(await remoteProjectChatBranchExists(input.cwd, input.branch))) {
    throw new Error('This chat has no pushed changes to finish');
  }

  if (input.workflow === 'pr-based') {
    const existing = await required(
      ['gh', 'pr', 'list', '--head', input.branch, '--state', 'all', '--json', 'url'],
      input.cwd
    );
    const prs = JSON.parse(existing) as Array<{ url: string }>;
    if (prs[0]?.url) return { status: 'pr', url: prs[0].url };

    const url = await required(
      [
        'gh',
        'pr',
        'create',
        '--title',
        input.summary,
        '--body',
        '',
        '--head',
        input.branch,
        '--base',
        input.trunk,
      ],
      input.cwd
    );
    return { status: 'pr', url };
  }

  const remote = await required(['git', 'remote', 'get-url', 'origin'], input.cwd);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-project-chat-finish-'));
  const cloneDir = path.join(tempDir, 'repo');
  try {
    await required(['git', 'clone', '--no-checkout', remote, cloneDir], input.cwd);
    await required(['git', 'checkout', '--detach', `origin/${input.branch}`], cloneDir);

    if (input.workflow === 'squash-rebase') {
      const marker = `Project-Chat-Id: ${input.chatId}`;
      const prior = await required(
        [
          'git',
          'log',
          `origin/${input.trunk}`,
          '--fixed-strings',
          `--grep=${marker}`,
          '--format=%H',
        ],
        cloneDir
      );
      if (prior) return { status: 'already_integrated', branch: input.trunk };
    }

    await required(['git', 'rebase', `origin/${input.trunk}`], cloneDir);
    const changes = await required(
      ['git', 'rev-list', '--count', `origin/${input.trunk}..HEAD`],
      cloneDir
    );
    if (changes === '0') return { status: 'already_integrated', branch: input.trunk };

    if (input.workflow === 'squash-rebase') {
      await required(['git', 'reset', '--soft', `origin/${input.trunk}`], cloneDir);
      const name = await required(['git', 'config', 'user.name'], input.cwd);
      const email = await required(['git', 'config', 'user.email'], input.cwd);
      await required(
        [
          'git',
          '-c',
          `user.name=${name}`,
          '-c',
          `user.email=${email}`,
          'commit',
          '-m',
          input.summary,
          '-m',
          `Project-Chat-Id: ${input.chatId}`,
        ],
        cloneDir
      );
    }

    await required(['git', 'push', 'origin', `HEAD:refs/heads/${input.trunk}`], cloneDir);
    return { status: 'integrated', branch: input.trunk };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
