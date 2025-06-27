import path from 'path';
import { getGitRoot } from '../common/git.js';
import { boldMarkdownHeaders, error, log, warn, writeStderr, writeStdout } from '../logging.js';
import { type PostApplyCommand } from './configSchema.js';

/**
 * Executes a single post-apply command as defined in the configuration.
 * This function integrates with the refactored common utilities, using src/common/git.ts
 * for repository root detection and src/common/process.ts patterns for command execution.
 *
 * The function handles:
 * - Working directory resolution relative to Git root
 * - Environment variable configuration
 * - Output buffering and conditional display based on success/failure
 * - Cross-platform shell command execution (Windows vs Unix)
 * - Graceful error handling with optional failure tolerance
 *
 * @param commandConfig - The configuration object for the command to execute
 * @param overrideGitRoot - Optional override for Git root directory detection
 * @returns Promise resolving to true if command succeeded or failure was allowed, false otherwise
 */
export async function executePostApplyCommand(
  commandConfig: PostApplyCommand,
  overrideGitRoot?: string
): Promise<boolean> {
  let effectiveGitRoot: string;
  try {
    if (overrideGitRoot) {
      effectiveGitRoot = overrideGitRoot;
    } else {
      effectiveGitRoot = await getGitRoot();
      if (!effectiveGitRoot) {
        // getGitRoot usually falls back to cwd, but handle defensively
        throw new Error('Could not determine Git repository root.');
      }
    }
  } catch (e) {
    error(
      `Error getting Git root for post-apply command: ${e instanceof Error ? e.message : String(e)}`
    );
    return false;
  }

  const cwd = commandConfig.workingDirectory
    ? path.resolve(effectiveGitRoot, commandConfig.workingDirectory)
    : effectiveGitRoot;

  const env = {
    ...process.env,
    ...(commandConfig.env || {}),
  };

  log(boldMarkdownHeaders(`\nRunning post-apply command: "${commandConfig.title}"...`));

  // Use sh -c or cmd /c for robust command string execution
  const isWindows = process.platform === 'win32';
  const shellCommand = isWindows ? 'cmd' : 'sh';
  const shellFlag = isWindows ? '/c' : '-c';
  const cmdArray = [shellCommand, shellFlag, commandConfig.command];
  const hideOutputOnSuccess = commandConfig.hideOutputOnSuccess;

  // Buffer output if hideOutputOnSuccess is true, otherwise inherit
  const outputBuffers: string[] = [];
  const proc = Bun.spawn(cmdArray, {
    cwd: cwd,
    env: env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  async function readStdout() {
    const stdoutDecoder = new TextDecoder();
    for await (const value of proc.stdout) {
      let output = stdoutDecoder.decode(value, { stream: true });
      if (hideOutputOnSuccess) {
        outputBuffers.push(output);
      } else {
        writeStdout(output);
      }
    }
  }

  async function readStderr() {
    const stderrDecoder = new TextDecoder();
    for await (const value of proc.stderr) {
      let output = stderrDecoder.decode(value, { stream: true });
      if (hideOutputOnSuccess) {
        outputBuffers.push(output);
      } else {
        writeStderr(output);
      }
    }
  }

  await Promise.all([readStdout(), readStderr()]);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    // If command failed, show buffered output if hideOutputOnSuccess is true
    if (commandConfig.hideOutputOnSuccess) {
      if (outputBuffers.length > 0) {
        log('Command output on failure:');
        outputBuffers.forEach((output) => writeStdout(output));
        writeStdout('\n');
      } else {
        log('Command produced no output on failure.');
      }
    }
    error(`Error: Post-apply command "${commandConfig.title}" failed with exit code ${exitCode}.`);
    if (commandConfig.allowFailure) {
      warn(
        `Warning: Failure of command "${commandConfig.title}" is allowed according to configuration.`
      );
      return true;
    } else {
      return false;
    }
  }

  log(`Post-apply command "${commandConfig.title}" completed successfully.`);
  return true;
}
