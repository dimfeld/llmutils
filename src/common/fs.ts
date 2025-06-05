import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { debugLog } from '../logging.js';

/**
 * Function to perform the path validation for secure file operations
 */
export function validatePath(baseDir: string, relativePath: string): string {
  const absoluteBaseDir = path.resolve(baseDir);
  const absoluteTargetPath = path.resolve(absoluteBaseDir, relativePath);

  // Normalize paths to handle '.' and '..' components and different OS separators
  const normalizedBaseDir = path.normalize(absoluteBaseDir);
  const normalizedTargetPath = path.normalize(absoluteTargetPath);

  // Check if the normalized target path is within the normalized base directory
  if (
    !normalizedTargetPath.startsWith(normalizedBaseDir + path.sep) &&
    normalizedTargetPath !== normalizedBaseDir
  ) {
    throw new Error(
      `Security Error: Attempted file operation outside of the base directory "${normalizedBaseDir}". Target: "${normalizedTargetPath}"`
    );
  }
  return normalizedTargetPath;
}

export async function secureWrite(
  baseDir: string,
  relativePath: string,
  content: string | Buffer
): Promise<void> {
  const absoluteTargetPath = validatePath(baseDir, relativePath);

  debugLog(`Securely writing to: ${absoluteTargetPath}`);
  await Bun.write(absoluteTargetPath, content);
}

export async function secureRm(baseDir: string, relativePath: string): Promise<void> {
  const absoluteTargetPath = validatePath(baseDir, relativePath);

  debugLog(`Securely removing: ${absoluteTargetPath}`);
  // Use force: true to mimic `rm -f`, avoiding errors if the file doesn't exist.
  // Keep recursive: false as we typically expect to remove files, not directories here.
  await fs.rm(absoluteTargetPath, { force: true, recursive: false });
}