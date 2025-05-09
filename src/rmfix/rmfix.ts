import { spawn } from 'bun';
import type { RmfixCoreOptions, RmfixRunResult } from './types.ts';
import { prepareCommand } from './command.ts';
import { Buffer } from 'node:buffer';
import { generateRmfilterOutput } from '../rmfilter/rmfilter.ts';
import type { GlobalValues, CommandParsed } from '../rmfilter/config.ts';
import path from 'node:path';
import { extractFileReferencesFromInstructions } from '../rmfilter/instructions.ts';
import { getGitRoot } from '../rmfilter/utils.ts';
import { log, debugLog } from '../logging.ts';

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

  debugLog(`[rmfix] Executing: ${command} ${commandArgs.join(' ')}`);

  try {
    const proc = spawn([command, ...commandArgs], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: process.env,
      cwd: process.cwd(),
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
    const fullOutput = `STDOUT:\n${stdoutStr}\n\nSTDERR:\n${stderrStr}`;

    return {
      stdout: stdoutStr,
      stderr: stderrStr,
      exitCode: exitCode,
      fullOutput: fullOutput,
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

    const stdoutOutput = '';
    const stderrOutput = errorMessage;
    return {
      stdout: stdoutOutput,
      stderr: stderrOutput,
      exitCode: failureExitCode,
      fullOutput: `STDOUT:\n${stdoutOutput}\n\nSTDERR:\n${stderrOutput}`,
    };
  }
}

/**
 * Main orchestrator for the rmfix utility.
 * Currently, it executes the command and logs its output.
 *
 * @param options The core options for running rmfix.
 * @returns A promise that resolves to the exit code of the executed command.
 */
export async function runRmfix(options: RmfixCoreOptions): Promise<number> {
  const { command: initialCommand, commandArgs: initialCommandArgs } = options;

  const { finalCommand, finalArgs } = await prepareCommand(initialCommand, initialCommandArgs);

  const result = await executeCoreCommand(finalCommand, finalArgs);

  debugLog(`[rmfix] stdout:\n${result.stdout}`);
  debugLog(`[rmfix] stderr:\n${result.stderr}`);
  debugLog(`[rmfix] exitCode: ${result.exitCode}`);

  if (result.exitCode !== 0) {
      `[rmfix] Command failed with exit code ${result.exitCode}. Assembling context with rmfilter...`
    );

    const rmfixCwd = process.cwd();
    const gitRoot = await getGitRoot(rmfixCwd);

    const { files: extractedAbsFiles, directories: extractedAbsDirs } =
      await extractFileReferencesFromInstructions(rmfixCwd, result.fullOutput);

    // Convert absolute paths from extractFileReferences to paths relative to rmfixCwd.
    // Paths starting with '..' are now allowed, as rmfilter can handle them relative to its baseDir.
    const extractedPathsRelativeToRmfixCwd = [...extractedAbsFiles, ...extractedAbsDirs]
      .map(p => path.relative(rmfixCwd, p));

    if (extractedPathsRelativeToRmfixCwd.length > 0) {
      debugLog(
        `[rmfix] Extracted paths from command output for rmfilter context: ${extractedPathsRelativeToRmfixCwd.join(', ')}`
      );
    }

    const constructedInstructionString = `The command "${options.command} ${options.commandArgs.join(' ')}" failed with exit code ${result.exitCode}.\n\nOutput:\n${result.fullOutput}\n\nPlease help fix the issue.`;

    const rmfilterGlobalValues: GlobalValues = {
      instructions: [constructedInstructionString],
      debug: options.cliOptions.debug ?? false,
      quiet: options.cliOptions.quiet ?? false,
      model: undefined,
      // editFormat is undefined, rmfilter will use its default
    };

    const rmfilterCommandsParsed: CommandParsed[] = [];
    const effectiveRmfilterPositionals = [...options.rmfilterArgs];
    const rmfilterValues: CommandParsed['values'] = {};

    if (extractedPathsRelativeToRmfixCwd.length > 0) {
      effectiveRmfilterPositionals.push(...extractedPathsRelativeToRmfixCwd);
      rmfilterValues['with-imports'] = true;
    }

    // Note: The current implementation assumes options.rmfilterArgs are purely positionals.
    // If options.rmfilterArgs could contain flags (e.g., "--with-imports" itself, or other rmfilter flags),
    // those flags would need to be parsed and merged into rmfilterValues.
    // For example, if options.rmfilterArgs included "--with-imports", rmfilterValues['with-imports']
    // should be true, which is consistent with the logic above.
    // This parsing is a potential future enhancement for rmfix.

    // If there are any positionals (either from CLI or extracted) or specific values to set
    if (effectiveRmfilterPositionals.length > 0 || Object.keys(rmfilterValues).length > 0) {
      const rmfilterCmdParsed: CommandParsed = {
        positionals: effectiveRmfilterPositionals,
        values: rmfilterValues,
      };
      rmfilterCommandsParsed.push(rmfilterCmdParsed);
    }
    // else: rmfilterCommandsParsed remains empty if no CLI args and no extracted files.
    // generateRmfilterOutput will throw an error if rmfilterCommandsParsed is empty and
    // no other context (like --with-diff) is provided, which is appropriate.

    try {
      const { finalOutput: rmfilterOutput } = await generateRmfilterOutput(
        { globalValues: rmfilterGlobalValues, commandsParsed: rmfilterCommandsParsed },
        rmfixCwd,
        gitRoot,
        constructedInstructionString
      );
      );
      log('\n--- rmfilter context ---');
      log(rmfilterOutput);
    } catch (rmfilterError) {
      log(
        `[rmfix] Error running rmfilter: ${rmfilterError instanceof Error ? rmfilterError.message : String(rmfilterError)}`
      );
    }
  }

  return result.exitCode;
}
