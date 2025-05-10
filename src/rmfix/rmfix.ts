import { spawn } from 'bun';
import type { RmfixCoreOptions, RmfixRunResult, ParsedTestFailure, OutputFormat } from './types.ts';
import { prepareCommand } from './command.ts';
import { Buffer } from 'node:buffer';
import { generateRmfilterOutput } from '../rmfilter/rmfilter.ts';
import type { GlobalValues, CommandParsed } from '../rmfilter/config.ts';
import { parseOutput } from './parsers.ts';
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
  const { command: initialCommand, commandArgs: initialCommandArgs, cliOptions } = options;

  const currentOutputFormat = cliOptions.format || 'auto';

  const { finalCommand, finalArgs } = await prepareCommand(
    initialCommand,
    initialCommandArgs,
    currentOutputFormat
  );

  const result = await executeCoreCommand(finalCommand, finalArgs);

  debugLog(`[rmfix] stdout:\n${result.stdout}`);
  debugLog(`[rmfix] stderr:\n${result.stderr}`);
  debugLog(`[rmfix] exitCode: ${result.exitCode}`);

  if (result.exitCode !== 0) {
    log(
      `[rmfix] Command failed with exit code ${result.exitCode}. Assembling context with rmfilter...`
    );

    const rmfixCwd = process.cwd();
    const gitRoot = await getGitRoot(rmfixCwd);

    const parsedFailures = parseOutput(result, currentOutputFormat, rmfixCwd);

    let mainInstructionString: string;
    const allFilePathsForRmfilter = new Set<string>();

    // Collect paths from extractFileReferencesFromInstructions (from raw output)
    const { files: rawExtractedAbsFiles, directories: rawExtractedAbsDirs } =
      await extractFileReferencesFromInstructions(rmfixCwd, result.fullOutput);

    const rawExtractedRelativePaths = [...rawExtractedAbsFiles, ...rawExtractedAbsDirs]
      .map((p) => path.relative(rmfixCwd, p))
      .filter((p) => p && p !== '.');

    if (rawExtractedRelativePaths.length > 0) {
      debugLog(
        `[rmfix] Extracted paths from raw command output: ${rawExtractedRelativePaths.join(', ')}`
      );
    }
    rawExtractedRelativePaths.forEach((p) => allFilePathsForRmfilter.add(p));

    if (parsedFailures.length > 0) {
      debugLog(`[rmfix] Parsed ${parsedFailures.length} failures from structured output.`);
      const failureDetails = parsedFailures
        .map((failure) => {
          const relativeTestFilePath = failure.testFilePath
            ? path.relative(rmfixCwd, failure.testFilePath)
            : 'Unknown file';

          if (failure.testFilePath) {
            const relPath = path.relative(rmfixCwd, failure.testFilePath);
            if (relPath && relPath !== '.') {
              allFilePathsForRmfilter.add(relPath);
            }
          }

          let detail = `The test '${failure.testName || 'Unknown test'}' in file '${relativeTestFilePath}' failed with message: ${failure.errorMessage}.`;
          if (failure.rawFailureDetails) {
            detail += `\nRaw details:\n${failure.rawFailureDetails}`;
          }
          return detail;
        })
        .join('\n\n');

      mainInstructionString = `The command "${options.command} ${options.commandArgs.join(' ')}" failed. Please help fix the following ${parsedFailures.length} test failure(s):\n\n${failureDetails}`;
    } else {
      debugLog(
        '[rmfix] No structured failures parsed, using generic failure message based on full output.'
      );
      mainInstructionString = `The command "${options.command} ${options.commandArgs.join(' ')}" failed with exit code ${result.exitCode}.\n\nOutput:\n${result.fullOutput}\n\nPlease help fix the issue.`;
    }

    const rmfilterGlobalValues: GlobalValues = {
      instructions: [mainInstructionString],
      debug: options.cliOptions.debug ?? false,
      quiet: options.cliOptions.quiet ?? false,
      model: undefined,
    };

    const rmfilterCommandsParsed: CommandParsed[] = [];
    const effectiveRmfilterPositionals = [...options.rmfilterArgs];
    const rmfilterValues: CommandParsed['values'] = {};

    // Note: The current implementation assumes options.rmfilterArgs are purely positionals.
    // If options.rmfilterArgs could contain flags (e.g., "--with-imports" itself, or other rmfilter flags),
    // those flags would need to be parsed and merged into rmfilterValues.
    // For example, if options.rmfilterArgs included "--with-imports", rmfilterValues['with-imports']
    // should be true, which is consistent with the logic above.
    // This parsing is a potential future enhancement for rmfix.

    const uniqueFilePathsArray = Array.from(allFilePathsForRmfilter);
    if (uniqueFilePathsArray.length > 0) {
      debugLog(
        `[rmfix] Adding unique files to rmfilter context: ${uniqueFilePathsArray.join(', ')}`
      );
      effectiveRmfilterPositionals.push(...uniqueFilePathsArray);
      rmfilterValues['with-imports'] = true;
    }

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
        mainInstructionString
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
