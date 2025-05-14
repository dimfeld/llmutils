import { getGitRoot, logSpawn } from '../rmfilter/utils.js';

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
