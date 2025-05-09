import { logSpawn } from '../rmfilter/utils.ts';
import type { RmfixRunResult } from './types.ts';
import { Buffer } from 'node:buffer';

/**
 * Executes a specified command and captures its output.
 *
 * @param command The command to execute.
 * @param commandArgs An array of arguments for the command.
 * @returns A promise that resolves to an RmfixRunResult object containing the
 *          captured stdout, stderr, exit code, and a combined full output.
 */
export async function executeCoreCommand(
  command: string,
  commandArgs: string[]
): Promise<RmfixRunResult> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const fullOutputParts: string[] = [];

  try {
    const proc = logSpawn([command, ...commandArgs], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    // Helper function to process a stream (stdout or stderr)
    const processStream = async (
      stream: ReadableStream<Uint8Array> | null,
      chunksArray: Buffer[],
      consoleStream: NodeJS.WriteStream
    ): Promise<void> => {
      if (!stream) return;

      for await (const chunk of stream) {
        const bufferChunk = Buffer.from(chunk);
        consoleStream.write(bufferChunk);
        chunksArray.push(bufferChunk);
        fullOutputParts.push(bufferChunk.toString('utf-8'));
      }
    };

    // Concurrently process stdout and stderr streams
    const stdoutPromise = processStream(proc.stdout, stdoutChunks, process.stdout);
    const stderrPromise = processStream(proc.stderr, stderrChunks, process.stderr);

    // Wait for both streams to finish processing
    await Promise.all([stdoutPromise, stderrPromise]);

    // Wait for the process to exit and get the exit code
    const exitCode = await proc.exited;

    const stdoutStr = Buffer.concat(stdoutChunks).toString('utf-8');
    const stderrStr = Buffer.concat(stderrChunks).toString('utf-8');
    const fullOutputStr = fullOutputParts.join('');

    return {
      stdout: stdoutStr,
      stderr: stderrStr,
      exitCode: exitCode,
      fullOutput: fullOutputStr,
    };
  } catch (error: any) {
    // This catch block handles errors primarily from Bun.spawn() itself,
    // e.g., if the command is not found or cannot be executed.
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Log this error to rmfix's own console for debugging.
    // This is distinct from the stderr of the command being run.
    console.error(
      `[rmfix] Error executing command '${command} ${commandArgs.join(' ')}': ${errorMessage}`
    );

    // Determine a suitable exit code for the failure.
    let failureExitCode = 1;
    if (error && typeof error.exitCode === 'number') {
      // If the error object (e.g., Bun.ProcessError) has an exitCode
      failureExitCode = error.exitCode;
    } else if (
      errorMessage.includes('ENOENT') ||
      errorMessage.toLowerCase().includes('command not found')
    ) {
      failureExitCode = 127;
    }

    return {
      stdout: '',
      stderr: errorMessage,
      exitCode: failureExitCode,
      fullOutput: errorMessage,
    };
  }
}
