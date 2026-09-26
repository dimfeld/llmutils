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

export async function remoteProjectChatBranchExists(cwd: string, branch: string): Promise<boolean> {
  const result = await run(['git', 'ls-remote', '--exit-code', '--heads', 'origin', branch], cwd);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 2) return false;
  throw new Error(result.stderr || 'Could not check the chat branch on origin');
}
