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

// TODO: Implement prepareCommand function
// This function will take the user's command and args,
// detect if it's an npm script, and return the actual command and args to run.
