/**
 * Detects the package manager used in the current project based on lockfile presence.
 *
 * @returns A promise that resolves to 'bun', 'yarn', or 'npm'.
 */
export async function detectPackageManager(): Promise<'npm' | 'bun' | 'yarn'> {
  if (await Bun.file('bun.lockb').exists()) {
    return 'bun';
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
  return script.trim().split(/\s+/).filter(s => s.length > 0);
}

// Helper to check for Jest JSON reporter (--json)
function hasJestJsonReporter(args: string[]): boolean {
  // Prioritize stdout: if no --json flag, add it.
  // Even if --outputFile is present, the task specifies to add --json if it's missing.
  return args.includes('--json');
}

// Helper to check for Vitest JSON reporters (--reporter=json or --reporter json)
function hasVitestJsonReporter(args: string[]): boolean {
  if (args.includes('--reporter=json')) {
    return true;
  }
  const reporterIndex = args.indexOf('--reporter');
  if (reporterIndex !== -1 && args.length > reporterIndex + 1 && args[reporterIndex + 1] === 'json') {
    return true;
  }
  return false;
}

/**
 * Prepares the command and arguments for execution, detecting npm scripts
 * and injecting JSON reporters for Jest/Vitest if necessary.
 *
 * @param commandOrScriptName The command to execute or npm script name (e.g., 'test', 'jest', 'npx').
 * @param userProvidedArgs Additional arguments for the command/script (e.g., ['--watch'] or ['jest', '--ci']).
 * @returns A promise that resolves to an object containing the final command and arguments.
 */
export async function prepareCommand(
  commandOrScriptName: string,
  userProvidedArgs: string[]
): Promise<{ finalCommand: string; finalArgs: string[] }> {
  let scriptExecutable: string;
  let scriptBaseArgs: string[];

  let isNpmScriptContext = false;
  let finalPackageManagerCommand = '';
  let finalPackageManagerArgsPrefix: string[] = [];

  const packageJsonPath = './package.json';
  const packageJsonFile = Bun.file(packageJsonPath);

  if (await packageJsonFile.exists()) {
    try {
      const packageJsonContent = await packageJsonFile.json();
      if (packageJsonContent?.scripts?.[commandOrScriptName]) {
        isNpmScriptContext = true;
        const scriptString = packageJsonContent.scripts[commandOrScriptName];
        const parsedScript = parseScriptString(scriptString);
        scriptExecutable = parsedScript[0];
        scriptBaseArgs = parsedScript.slice(1);

        finalPackageManagerCommand = await detectPackageManager();
        finalPackageManagerArgsPrefix = ['run', commandOrScriptName];
      } else {
        // Not an npm script in package.json, treat commandOrScriptName as the direct executable
        scriptExecutable = commandOrScriptName;
        scriptBaseArgs = [];
      }
    } catch (error) {
      console.warn(
        `[rmfix] Warning: Could not parse ${packageJsonPath}. Error: ${error instanceof Error ? error.message : String(error)}`
      );
      scriptExecutable = commandOrScriptName;
      scriptBaseArgs = [];
    }
  } else {
    // No package.json, treat commandOrScriptName as the direct executable
    scriptExecutable = commandOrScriptName;
    scriptBaseArgs = [];
  }

  // `currentCommand` is the command we are analyzing (e.g., "jest", "vitest", or "npx").
  // `currentArgs` are the arguments associated with `currentCommand` (e.g. ["--coverage", "--watch"] for "vitest", or ["jest", "--ci"] for "npx").
  let currentCommand = scriptExecutable;
  let currentArgs = [...scriptBaseArgs, ...userProvidedArgs];

  // Args that will be modified by reporter injection.
  // These are the args for the `runnerToAnalyze` if it's the runner itself,
  // or for the sub-command if `currentCommand` is like `npx`.
  let runnerToAnalyze = currentCommand;
  let argsForRunner = currentArgs; 
  let isSubCommandRunner = false; 
  let subCommandPrefixArgs: string[] = [];
  let subCommandName = "";

  const lowerCaseCurrentCommand = currentCommand.toLowerCase();
  if (['npx', 'pnpm', 'pnpx'].includes(lowerCaseCurrentCommand) || 
      (lowerCaseCurrentCommand === 'yarn' && currentArgs[0]?.toLowerCase() === 'dlx')) {

    let potentialRunnerNameIndexInArgs = 0;
    subCommandPrefixArgs = [currentCommand];

    if (lowerCaseCurrentCommand === 'yarn' && currentArgs[0]?.toLowerCase() === 'dlx') {
        potentialRunnerNameIndexInArgs = 1; 
        subCommandPrefixArgs.push(currentArgs[0]);
    }

    if (currentArgs.length > potentialRunnerNameIndexInArgs) {
      const potentialRunnerName = currentArgs[potentialRunnerNameIndexInArgs];
      if (potentialRunnerName.includes('jest') || potentialRunnerName.includes('vitest')) {
        runnerToAnalyze = potentialRunnerName;
        subCommandName = potentialRunnerName;
        argsForRunner = currentArgs.slice(potentialRunnerNameIndexInArgs + 1);
        isSubCommandRunner = true;
      }
    }
  }

  // Perform injection on `argsForRunner`
  if (runnerToAnalyze.includes('jest')) {
    if (!hasJestJsonReporter(argsForRunner)) {
      argsForRunner.unshift('--json');
    }
  } else if (runnerToAnalyze.includes('vitest')) {
    if (!hasVitestJsonReporter(argsForRunner)) {
      argsForRunner.unshift('--reporter=json');
    }
  }

  // Reconstruct `currentArgs` if injection happened for a sub-command
  if (isSubCommandRunner) {
    currentArgs = [subCommandName, ...argsForRunner];
  } else {
    currentArgs = argsForRunner;
  }

  if (isNpmScriptContext) {
    const finalArgs = [...finalPackageManagerArgsPrefix];
    // The arguments to pass to the script (after '--') are composed of the script's executable (if not part of package manager like npx)
    // and its (now modified) arguments.
    // scriptExecutable was the first part of the script string (e.g. "vitest" or "npx")
    // currentArgs are the modified args for that scriptExecutable (e.g. ["--reporter=json", "--coverage"] or ["jest", "--json", "--ci"])
    const fullScriptExecutionParts = [scriptExecutable, ...currentArgs];
    if (fullScriptExecutionParts.length > 0) {
      finalArgs.push('--', ...fullScriptExecutionParts);
    }
    return { finalCommand: finalPackageManagerCommand, finalArgs: finalArgs };
  } else {
    // Not an npm script.
    // currentCommand is the command (e.g. "jest", "npx")
    // currentArgs are its (potentially modified) args (e.g. ["--json", "--watch"] or ["jest", "--json", "--watch"])
    if (isSubCommandRunner) {
        // The command to run is the prefix (e.g. "npx"), and its args are currentArgs
        return { finalCommand: subCommandPrefixArgs.join(' '), finalArgs: currentArgs };
    }
    return { finalCommand: currentCommand, finalArgs: currentArgs };
  }
}
}
