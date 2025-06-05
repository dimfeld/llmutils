import { logSpawn, debug } from '../rmfilter/utils.js';
import { getGitRoot } from '../common/git.js';
import { debugLog } from '../logging.js';
import * as path from 'node:path';

/**
 * Fetches the content of a file at a specific Git reference (branch, commit hash, etc.).
 * @param filePath The path to the file, relative to the Git repository root.
 * @param ref The Git reference (e.g., 'main', 'HEAD', 'a1b2c3d').
 * @param cwd The working directory to run the git command in. Defaults to getGitRoot().
 * @returns A promise that resolves to the file content as a string.
 * @throws An error if the Git command fails or the file is not found at the specified ref.
 */
export async function getFileContentAtRef(
  filePath: string,
  ref: string,
  cwd?: string
): Promise<string> {
  const gitRoot = cwd || (await getGitRoot());
  const command = ['git', 'show', `${ref}:${filePath}`];

  const proc = logSpawn(command, {
    cwd: gitRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout as ReadableStream).text();
  const stderr = await new Response(proc.stderr as ReadableStream).text();

  if (exitCode !== 0) {
    const errorMsg = stderr.trim();
    throw new Error(
      `Failed to get file content for '${filePath}' at ref '${ref}'. ` +
        `Git command: '${command.join(' ')}' (cwd: ${gitRoot}). Exit code: ${exitCode}. ` +
        `Stderr: ${errorMsg || '(empty)'}`
    );
  }
  return stdout;
}

/**
 * Gets the diff of a specific file between two Git references.
 * @param filePath The path to the file, relative to the Git repository root.
 * @param baseRef The base Git reference for the diff.
 * @param headRef The head Git reference for the diff.
 * @param cwd The working directory to run the git command in. Defaults to getGitRoot().
 * @returns A promise that resolves to the diff output as a string.
 *          Returns an empty string if there is no diff for the file.
 * @throws An error if the Git command fails.
 */
export async function getDiff(
  filePath: string,
  baseRef: string,
  headRef: string,
  cwd?: string
): Promise<string> {
  const gitRoot = cwd || (await getGitRoot());
  const command = ['git', 'diff', '--patch', `${baseRef}..${headRef}`, '--', filePath];

  const proc = logSpawn(command, {
    cwd: gitRoot,
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout as ReadableStream).text();
  const stderr = await new Response(proc.stderr as ReadableStream).text();

  if (exitCode !== 0) {
    const errorMsg = stderr.trim();
    throw new Error(
      `Failed to get diff for '${filePath}' between '${baseRef}' and '${headRef}'. ` +
        `Git command: '${command.join(' ')}' (cwd: ${gitRoot}). Exit code: ${exitCode}. ` +
        `Stderr: ${errorMsg || '(empty)'}`
    );
  }
  return stdout;
}

/**
 * Gets the SHA of the current commit (HEAD for git, @- for jj).
 * @param cwd The working directory to run the command in. Defaults to process.cwd().
 * @returns A promise that resolves to the commit SHA string if successful, or null if an error occurs.
 */
export async function getCurrentCommitSha(cwd?: string): Promise<string | null> {
  const workingDir = cwd || process.cwd();

  // Check if jj exists in the provided directory
  const jjPath = path.join(workingDir, '.jj');
  const hasJj = await Bun.file(jjPath)
    .stat()
    .then((s) => s.isDirectory())
    .catch(() => false);

  try {
    if (hasJj) {
      // For jj, get the last commit ID
      const proc = logSpawn(['jj', 'log', '-r', '@-', '--no-graph', '-T', 'commit_id'], {
        cwd: workingDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ]);

      if (exitCode === 0) {
        return stdout.trim();
      }

      debugLog(
        'Failed to get current jj commit ID. Exit code: %d, stderr: %s',
        exitCode,
        stderr.trim()
      );
      return null;
    } else {
      // For git, use rev-parse HEAD
      const proc = logSpawn(['git', 'rev-parse', 'HEAD'], {
        cwd: workingDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ]);

      if (exitCode === 0) {
        return stdout.trim();
      }

      debugLog(
        'Failed to get current git commit SHA. Exit code: %d, stderr: %s',
        exitCode,
        stderr.trim()
      );
      return null;
    }
  } catch (error) {
    debugLog('Error getting current commit SHA: %o', error);
    return null;
  }
}
