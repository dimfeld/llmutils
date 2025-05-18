import { getGitRoot, logSpawn, debug } from '../rmfilter/utils.js';
import { debugLog } from '../logging.js';

/**
 * Gets the name of the current Git branch.
 * @returns A promise that resolves to the current branch name, or null if in a detached HEAD state or not in a Git repository.
 */
export async function getCurrentGitBranch(): Promise<string | null> {
  try {
    const proc = logSpawn(['git', 'branch', '--show-current'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);

    if (exitCode !== 0) {
      if (debug) {
        debugLog(
          'Failed to get current Git branch. Exit code: %d, stderr: %s',
          exitCode,
          stderr.trim()
        );
      }
      return null;
    }

    const branchName = stdout.trim();
    return branchName || null;
  } catch (error) {
    if (debug) {
      debugLog('Error getting current Git branch: %o', error);
    }
    return null;
  }
}

/**
 * Fetches the content of a file at a specific Git reference (branch, commit hash, etc.).
 * @param filePath The path to the file, relative to the Git repository root.
 * @param ref The Git reference (e.g., 'main', 'HEAD', 'a1b2c3d').
 * @returns A promise that resolves to the file content as a string.
 * @throws An error if the Git command fails or the file is not found at the specified ref.
 */
export async function getFileContentAtRef(filePath: string, ref: string): Promise<string> {
  const gitRoot = await getGitRoot();
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
 * Gets the name of the current Jujutsu branch.
 * @returns A promise that resolves to the current branch name, or null if not in a Jujutsu repository or no branch found.
 */
export async function getCurrentJujutsuBranch(): Promise<string | null> {
  try {
    const proc = logSpawn(
      [
        'jj',
        'log',
        '-r',
        'latest(heads(ancestors(@) & bookmarks()), 1)',
        '--limit',
        '1',
        '--no-graph',
        '--ignore-working-copy',
        '-T',
        'bookmarks',
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);

    if (exitCode !== 0) {
      if (debug) {
        debugLog(
          'Failed to get current Jujutsu branch. Exit code: %d, stderr: %s',
          exitCode,
          stderr.trim()
        );
      }
      return null;
    }

    const branchNames = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (branchNames.length === 0) {
      return null;
    }

    if (branchNames.length === 1) {
      return branchNames[0];
    }

    // Filter out 'main' and 'master' branches
    const filteredBranches = branchNames.filter(
      (branch) => branch !== 'main' && branch !== 'master'
    );

    // Return the first non-main/master branch if any exist, otherwise first branch from original list
    return filteredBranches.length > 0 ? filteredBranches[0] : branchNames[0];
  } catch (error) {
    if (debug) {
      debugLog('Error getting current Jujutsu branch: %o', error);
    }
    return null;
  }
}

/**
 * Gets the diff of a specific file between two Git references.
 * @param filePath The path to the file, relative to the Git repository root.
 * @param baseRef The base Git reference for the diff.
 * @param headRef The head Git reference for the diff.
 * @returns A promise that resolves to the diff output as a string.
 *          Returns an empty string if there is no diff for the file.
 * @throws An error if the Git command fails.
 */
export async function getDiff(filePath: string, baseRef: string, headRef: string): Promise<string> {
  const gitRoot = await getGitRoot();
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
 * Gets the current branch name by trying Git first, then Jujutsu.
 * @returns A promise that resolves to the current branch name, or null if neither Git nor Jujutsu is available or in a detached HEAD state.
 */
export async function getCurrentBranchName(): Promise<string | null> {
  const gitBranch = await getCurrentGitBranch();
  if (gitBranch !== null) {
    return gitBranch;
  }
  return await getCurrentJujutsuBranch();
}

/**
 * Gets the SHA of the current Git commit (HEAD).
 * @returns A promise that resolves to the commit SHA string if successful, or null if an error occurs.
 */
export async function getCurrentCommitSha(): Promise<string | null> {
  try {
    const proc = logSpawn(['git', 'rev-parse', 'HEAD'], {
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
      'Failed to get current commit SHA. Exit code: %d, stderr: %s',
      exitCode,
      stderr.trim()
    );
    return null;
  } catch (error) {
    debugLog('Error getting current commit SHA: %o', error);
    return null;
  }
}
