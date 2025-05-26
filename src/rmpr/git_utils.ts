import { getGitRoot, logSpawn, debug } from '../rmfilter/utils.js';
import { debugLog } from '../logging.js';
import * as path from 'node:path';

/**
 * Gets the name of the current Git branch.
 * @param cwd The working directory to run the git command in. Defaults to process.cwd().
 * @returns A promise that resolves to the current branch name, or null if in a detached HEAD state or not in a Git repository.
 */
export async function getCurrentGitBranch(cwd?: string): Promise<string | null> {
  try {
    const proc = logSpawn(['git', 'branch', '--show-current'], {
      cwd: cwd || process.cwd(),
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
 * Gets the name of the current Jujutsu branch.
 * @param cwd The working directory to run the jj command in. Defaults to process.cwd().
 * @returns A promise that resolves to the current branch name, or null if not in a Jujutsu repository or no branch found.
 */
export async function getCurrentJujutsuBranch(cwd?: string): Promise<string | null> {
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
        cwd: cwd || process.cwd(),
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
      const branch = branchNames[0];
      if (branch.endsWith('*')) {
        return branch.slice(0, -1);
      } else {
        return branch;
      }
    }

    // Filter out 'main' and 'master' branches
    const filteredBranches = branchNames.filter(
      (branch) => branch !== 'main' && branch !== 'master'
    );

    // Return the first non-main/master branch if any exist, otherwise first branch from original list
    const branch = filteredBranches.length > 0 ? filteredBranches[0] : branchNames[0];
    if (branch.endsWith('*')) {
      return branch.slice(0, -1);
    } else {
      return branch;
    }
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
 * Gets the current branch name by trying Git first, then Jujutsu.
 * @param cwd The working directory to run the commands in. Defaults to process.cwd().
 * @returns A promise that resolves to the current branch name, or null if neither Git nor Jujutsu is available or in a detached HEAD state.
 */
export async function getCurrentBranchName(cwd?: string): Promise<string | null> {
  const gitBranch = await getCurrentGitBranch(cwd);
  if (gitBranch !== null) {
    return gitBranch;
  }
  return await getCurrentJujutsuBranch(cwd);
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

/**
 * Pushes a branch to a remote repository.
 * @param branchName The name of the branch to push.
 * @param workspacePath The working directory to run the git command in.
 * @param remoteName The name of the remote repository. Defaults to 'origin'.
 * @returns A promise that resolves to an object indicating success and any error message.
 */
export async function pushBranch(
  branchName: string,
  workspacePath: string,
  remoteName: string = 'origin'
): Promise<{ success: boolean; error?: string }> {
  try {
    const proc = logSpawn(['git', 'push', remoteName, branchName], {
      cwd: workspacePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);

    if (exitCode === 0) {
      debugLog(`Successfully pushed branch ${branchName} to ${remoteName}`);
      return { success: true };
    } else {
      const errorMsg = stderr.trim() || stdout.trim() || 'Unknown error';
      debugLog(`Failed to push branch ${branchName}. Exit code: ${exitCode}, stderr: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`Error pushing branch ${branchName}: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

/**
 * Gets the current branch name using git rev-parse.
 * @param workspacePath The working directory to run the git command in.
 * @returns A promise that resolves to the current branch name, or null if not on a branch.
 */
export async function getCurrentBranch(workspacePath: string): Promise<string | null> {
  try {
    const proc = logSpawn(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workspacePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);

    if (exitCode === 0) {
      const branch = stdout.trim();
      // If HEAD is returned, we're in detached HEAD state
      return branch === 'HEAD' ? null : branch;
    } else {
      debugLog(`Failed to get current branch. Exit code: ${exitCode}, stderr: ${stderr.trim()}`);
      return null;
    }
  } catch (error) {
    debugLog(`Error getting current branch: ${error}`);
    return null;
  }
}

/**
 * Commits all changes in the working directory with the given message.
 * @param workspacePath The working directory to run the git command in.
 * @param message The commit message.
 * @returns A promise that resolves to an object indicating success and any error message.
 */
export async function commitChanges(
  workspacePath: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // First check if there are any changes to commit
    const statusProc = logSpawn(['git', 'status', '--porcelain'], {
      cwd: workspacePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [statusExitCode, statusStdout] = await Promise.all([
      statusProc.exited,
      new Response(statusProc.stdout as ReadableStream).text(),
    ]);

    if (statusExitCode !== 0) {
      return { success: false, error: 'Failed to check git status' };
    }

    // If no changes, return success without committing
    if (statusStdout.trim() === '') {
      debugLog('No changes to commit');
      return { success: true };
    }

    // Commit all changes
    const proc = logSpawn(['git', 'commit', '-am', message], {
      cwd: workspacePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);

    if (exitCode === 0) {
      debugLog(`Successfully committed changes with message: ${message}`);
      return { success: true };
    } else {
      const errorMsg = stderr.trim() || stdout.trim() || 'Unknown error';
      debugLog(`Failed to commit changes. Exit code: ${exitCode}, stderr: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`Error committing changes: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}
