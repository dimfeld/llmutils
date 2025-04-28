import * as path from 'node:path';
import { getGitRoot } from '../rmfilter/utils.js';
import { debugLog } from '../logging.js';

/**
 * Finds the absolute path to the rmplan configuration file.
 *
 * It searches in the following order:
 * 1. The path specified by `overridePath` (if provided).
 * 2. The default path `.rmfilter/rmplan.yml` in the Git repository root.
 *
 * @param overridePath - An optional path explicitly provided by the user (e.g., via CLI flag).
 * @returns The absolute path to the configuration file if found, otherwise `null`.
 * @throws {Error} If `overridePath` is provided but the file does not exist.
 */
export async function findConfigPath(overridePath?: string): Promise<string | null> {
  if (overridePath) {
    const absoluteOverridePath = path.resolve(overridePath);
    const fileExists = await Bun.file(absoluteOverridePath).exists();
    if (!fileExists) {
      throw new Error(`Specified configuration file not found: ${absoluteOverridePath}`);
    }
    debugLog(`Using configuration file specified via override: ${absoluteOverridePath}`);
    return absoluteOverridePath;
  }

  try {
    const gitRoot = await getGitRoot();
    if (!gitRoot) {
      debugLog('Could not determine Git repository root. Skipping default config search.');
      return null;
    }
    const defaultPath = path.join(gitRoot, '.rmfilter', 'rmplan.yml');
    const fileExists = await Bun.file(defaultPath).exists();
    debugLog(`Checking for default configuration file at: ${defaultPath}`);
    return fileExists ? defaultPath : null;
  } catch (error: any) {
    debugLog(`Error finding Git root or checking default config: ${error.message}`);
    return null; // Gracefully handle errors like not being in a git repo
  }
}
