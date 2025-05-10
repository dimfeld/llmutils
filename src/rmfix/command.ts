import path from 'node:path';
import { findUp } from 'find-up';

/**
 * Detects the package manager used in the current project based on lockfile presence.
 *
 * @returns A promise that resolves to 'bun', 'yarn', or 'npm'.
 */
export async function detectPackageManager(): Promise<'npm' | 'pnpm' | 'bun' | 'yarn'> {
  if (await Bun.file('bun.lockb').exists()) {
    return 'bun';
  }

  if (await Bun.file('pnpm-lock.yaml').exists()) {
    return 'pnpm';
  }

  if (await Bun.file('yarn.lock').exists()) {
    return 'yarn';
  }

  if (await Bun.file('package-lock.json').exists()) {
    return 'npm';
  }

  return 'npm';
}

// Helper to parse a script string like "cmd --arg1 val1 --arg2" into [cmd, --arg1, val1, --arg2]
function parseScriptString(script: string): string[] {
  return script
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);
}

// Define OutputFormat type (can be moved to types.ts later)
export type OutputFormat = 'auto' | 'json' | 'tap' | 'text';

// Helper function to check for existing JSON reporters
function hasReporterArg(args: string[], runner: 'jest' | 'vitest'): boolean {
  if (runner === 'jest') {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--reporters' && i + 1 < args.length && args[i + 1].includes('json'))
        return true;
      if (args[i].startsWith('--reporters=') && args[i].includes('json')) return true;
    }
  } else if (runner === 'vitest') {
    // Checks for --reporter=json or --reporter json
    if (args.includes('--reporter=json')) return true;
    const reporterIndex = args.indexOf('--reporter');
    if (
      reporterIndex !== -1 &&
      args.length > reporterIndex + 1 &&
      args[reporterIndex + 1].includes('json')
    ) {
      return true;
    }
    // Also check for --reporter=some-json-variant or --reporter some-json-variant
    return args.some(
      (arg) =>
        (arg.startsWith('--reporter=') || arg.startsWith('--reporter ')) && arg.includes('json')
    );
  }
  return false;
}

/**
 * Prepares the command and arguments for execution, detecting npm scripts
 * and injecting JSON reporters for Jest/Vitest if necessary.
 *
 * @param commandOrScriptName The command to execute or npm script name (e.g., 'test', 'jest', 'npx').
 * @param userProvidedArgs Additional arguments for the command/script (e.g., ['--watch'] or ['jest', '--ci']).
 * @param currentFormat The desired output format, influencing reporter injection.
 * @returns A promise that resolves to an object containing the final command and arguments.
 */
export async function prepareCommand(
  initialCommand: string,
  initialCommandArgs: string[],
  currentFormat: OutputFormat | 'auto' = 'auto'
): Promise<{ finalCommand: string; finalArgs: string[] }> {
  let scriptExecutable: string;
  let scriptBaseArgs: string[];

  let isNpmScriptContext = false;
  let finalPackageManagerCommand = '';
  let finalPackageManagerArgsPrefix: string[] = [];

  const packageJsonPath = await findUp('package.json');

  if (packageJsonPath) {
    try {
      const packageJsonContent = (await Bun.file(packageJsonPath).json()) as {
        scripts?: Record<string, string>;
      };
      if (packageJsonContent?.scripts?.[initialCommand]) {
        isNpmScriptContext = true;
        const scriptString = packageJsonContent.scripts[initialCommand];
        const parsedScript = parseScriptString(scriptString);
        scriptExecutable = parsedScript[0];
        scriptBaseArgs = parsedScript.slice(1);

        finalPackageManagerCommand = await detectPackageManager();
        finalPackageManagerArgsPrefix = ['run', initialCommand];
      } else {
        // Not an npm script in package.json, treat commandOrScriptName as the direct executable
        scriptExecutable = initialCommand;
        scriptBaseArgs = [];
      }
    } catch (error) {
      console.warn(
        `[rmfix] Warning: Could not parse ${packageJsonPath}. Error: ${error instanceof Error ? error.message : String(error)}`
      );
      scriptExecutable = initialCommand;
      scriptBaseArgs = [];
    }
  } else {
    // No package.json, treat commandOrScriptName as the direct executable
    scriptExecutable = initialCommand;
    scriptBaseArgs = [];
  }

  // `currentCommand` is the command we are analyzing (e.g., "jest", "vitest", or "npx").
  // `currentArgs` are the arguments associated with `currentCommand` (e.g. ["--coverage", "--watch"] for "vitest", or ["jest", "--ci"] for "npx").
  let currentCommand = scriptExecutable;
  let currentArgs = [...initialCommandArgs];

  // To analyze the full command line.
  let fullArgs = [...scriptBaseArgs, ...initialCommandArgs];

  // Args that will be modified by reporter injection.
  // These are the args for the `runnerToAnalyze` if it's the runner itself,
  // or for the sub-command if `currentCommand` is like `npx`.
  let runnerToAnalyze = currentCommand;
  let isSubCommandRunner = false;
  let subCommandPrefixParts: string[] = [];
  let subCommandName = '';

  const lowerCaseCurrentCommand = currentCommand.toLowerCase();
  const firstSubcommand = fullArgs[0];
  if (
    ['npx', 'pnpm', 'pnpx', 'bunx'].includes(lowerCaseCurrentCommand) ||
    (lowerCaseCurrentCommand === 'yarn' && firstSubcommand?.toLowerCase() === 'dlx')
  ) {
    let potentialRunnerNameIndexInArgs = 0;
    subCommandPrefixParts = [currentCommand];

    if (lowerCaseCurrentCommand === 'yarn' && firstSubcommand?.toLowerCase() === 'dlx') {
      potentialRunnerNameIndexInArgs = 1;
      subCommandPrefixParts.push(firstSubcommand);
    }

    if (fullArgs.length > potentialRunnerNameIndexInArgs) {
      const potentialRunnerName = fullArgs[potentialRunnerNameIndexInArgs];
      if (potentialRunnerName.includes('jest') || potentialRunnerName.includes('vitest')) {
        runnerToAnalyze = potentialRunnerName;
        subCommandName = potentialRunnerName;
        isSubCommandRunner = true;
      }
    }
  }

  // Reporter Injection Logic
  if (currentFormat === 'auto' || currentFormat === 'json') {
    const runnerId = runnerToAnalyze.toLowerCase();

    if (runnerId.includes('jest')) {
      // Check for --json flag OR --reporters flag with json
      const alreadyHasJson = fullArgs.includes('--json') || hasReporterArg(fullArgs, 'jest');
      if (!alreadyHasJson) {
        currentArgs.push('--json');
      }
    } else if (runnerId.includes('vitest')) {
      if (!hasReporterArg(fullArgs, 'vitest')) {
        currentArgs.push('--reporter=json');
      }
    }
  }

  // console.log({
  //   runnerToAnalyze,
  //   scriptExecutable,
  //   scriptBaseArgs,
  //   initialCommand,
  //   initialCommandArgs,
  //   isNpmScriptContext,
  //   finalPackageManagerCommand,
  //   isSubCommandRunner,
  //   subCommandName,
  // });
  if (isNpmScriptContext) {
    const finalArgs = [...finalPackageManagerArgsPrefix];
    // The arguments to pass to the script (after '--') are composed of the script's executable (if not part of package manager like npx)
    // and its (now modified) arguments.
    // scriptExecutable was the first part of the script string (e.g. "vitest" or "npx")
    // currentArgs are the modified args for that scriptExecutable (e.g. ["--reporter=json", "--coverage"] or ["jest", "--json", "--ci"])
    if (currentArgs.length > 0) {
      finalArgs.push('--', ...currentArgs);
    }
    return { finalCommand: finalPackageManagerCommand, finalArgs: finalArgs };
  } else {
    // Not an npm script.
    // currentCommand is the command (e.g. "jest", "npx")
    return { finalCommand: currentCommand, finalArgs: currentArgs };
  }
}
