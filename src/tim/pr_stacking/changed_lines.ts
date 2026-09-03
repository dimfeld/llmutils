interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCommand(args: string[], cwd: string): Promise<CommandResult> {
  const process = Bun.spawn(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout as ReadableStream).text(),
    new Response(process.stderr as ReadableStream).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export function parseGitNumstat(output: string): number {
  return output.split('\n').reduce((total: number, line: string): number => {
    const [added, deleted] = line.split('\t');
    const additions = Number.parseInt(added ?? '', 10);
    const deletions = Number.parseInt(deleted ?? '', 10);
    return (
      total + (Number.isNaN(additions) ? 0 : additions) + (Number.isNaN(deletions) ? 0 : deletions)
    );
  }, 0);
}

export function parseGitPatchChangedLines(output: string): number {
  return output.split('\n').reduce((total: number, line: string): number => {
    if (
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---'))
    ) {
      return total + 1;
    }
    return total;
  }, 0);
}

export async function countChangedLines(
  cwd: string,
  comparisonRef: string,
  vcsType: 'git' | 'jj'
): Promise<number> {
  const args =
    vcsType === 'jj'
      ? ['jj', 'diff', '--from', comparisonRef, '--to', '@', '--git']
      : ['git', 'diff', '--numstat', comparisonRef];
  const result = await runCommand(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `${vcsType} diff failed while counting changed lines: ${result.stderr.trim() || `exit code ${result.exitCode}`}`
    );
  }
  return vcsType === 'jj'
    ? parseGitPatchChangedLines(result.stdout)
    : parseGitNumstat(result.stdout);
}
