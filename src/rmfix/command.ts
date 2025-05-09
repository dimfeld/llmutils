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

  // Default to npm if no lockfile is found
  return 'npm';
}

/**
 * Prepares the command and arguments for execution, detecting npm scripts.
 *
 * @param command The command to potentially execute (e.g., 'test', 'lint').
 * @param commandArgs Additional arguments for the command.
 * @returns A promise that resolves to an object containing the final command and arguments.
 */
export async function prepareCommand(
  command: string,
  commandArgs: string[]
): Promise<{ finalCommand: string; finalArgs: string[] }> {
  const packageJsonPath = './package.json';
  const packageJsonFile = Bun.file(packageJsonPath);

  if (await packageJsonFile.exists()) {
    try {
      const packageJsonContent = await packageJsonFile.json();
      if (
        packageJsonContent &&
        typeof packageJsonContent === 'object' &&
        'scripts' in packageJsonContent &&
        typeof packageJsonContent.scripts === 'object' &&
        packageJsonContent.scripts &&
        command in packageJsonContent.scripts
      ) {
        // It's an npm script
        const packageManager = await detectPackageManager();
        return {
          finalCommand: packageManager,
          finalArgs: ['run', command, ...commandArgs],
        };
      }
    } catch (error) {
      // TODO: Replace with proper warn from src/logging.ts
      console.warn(
        `[rmfix] Warning: Could not parse ${packageJsonPath}. Proceeding as if it's not an npm script. Error: ${error instanceof Error ? error.message : String(error)}`
      );
      // Fall through to treat as a direct command
    }
  }

  // Not an npm script or package.json not found/unparseable
  return { finalCommand: command, finalArgs: commandArgs };
}
