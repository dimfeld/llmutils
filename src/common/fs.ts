/**
 * @fileoverview Secure file system utilities for the llmutils codebase.
 * This module provides secure file operations that prevent path traversal attacks
 * and ensure all file operations remain within designated base directories.
 *
 * All functions in this module validate paths before performing operations to
 * prevent malicious path traversal attempts using ".." or other techniques.
 * This is especially important when dealing with user-provided file paths or
 * when operating on files specified in plan configurations.
 *
 * Key capabilities:
 * - Path validation and normalization
 * - Secure file writing with directory traversal protection
 * - Secure file removal with safety checks
 * - Base directory containment enforcement
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { debugLog } from '../logging.js';

/**
 * Validates that a file path is within the specified base directory to prevent
 * path traversal attacks. This function normalizes paths and ensures the target
 * path cannot escape the base directory using ".." or other traversal techniques.
 *
 * @param baseDir - The base directory that operations should be constrained to
 * @param relativePath - The relative path to validate and resolve
 * @returns The absolute, normalized path if validation succeeds
 * @throws {Error} If the path would escape the base directory (security violation)
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

/**
 * Securely writes content to a file after validating the path is within the base directory.
 * This function prevents path traversal attacks by validating that the target file
 * is within the specified base directory before performing the write operation.
 *
 * @param baseDir - The base directory that constrains where files can be written
 * @param relativePath - The relative path where the file should be written
 * @param content - The content to write (string or Buffer)
 * @throws {Error} If the path would escape the base directory or write operation fails
 */
export async function secureWrite(
  baseDir: string,
  relativePath: string,
  content: string | Buffer
): Promise<void> {
  const absoluteTargetPath = validatePath(baseDir, relativePath);

  debugLog(`Securely writing to: ${absoluteTargetPath}`);
  await Bun.write(absoluteTargetPath, content);
}

/**
 * Securely removes a file after validating the path is within the base directory.
 * This function prevents path traversal attacks by validating that the target file
 * is within the specified base directory before performing the removal operation.
 * Uses force mode to avoid errors if the file doesn't exist.
 *
 * @param baseDir - The base directory that constrains where files can be removed
 * @param relativePath - The relative path of the file to remove
 * @throws {Error} If the path would escape the base directory or removal operation fails
 */
export async function secureRm(baseDir: string, relativePath: string): Promise<void> {
  const absoluteTargetPath = validatePath(baseDir, relativePath);

  debugLog(`Securely removing: ${absoluteTargetPath}`);
  // Use force: true to mimic `rm -f`, avoiding errors if the file doesn't exist.
  // Keep recursive: false as we typically expect to remove files, not directories here.
  await fs.rm(absoluteTargetPath, { force: true, recursive: false });
}

export type ClearManagedDirectoryContentsSafelyOptions = {
  baseDir: string;
  relativeDir: string;
  label: string;
  create?: boolean;
};

export async function clearManagedDirectoryContentsSafely(
  options: ClearManagedDirectoryContentsSafelyOptions
): Promise<void> {
  const create = options.create ?? true;
  assertSafeManagedRelativeDir(options.relativeDir, options.label);
  const realBaseDir = await fs.realpath(options.baseDir);
  const absoluteDir = validatePath(realBaseDir, options.relativeDir);

  await assertManagedDirectoryPathIsSymlinkSafe({
    baseDir: realBaseDir,
    absoluteDir,
    label: options.label,
  });

  if (create) {
    await fs.mkdir(absoluteDir, { recursive: true });
  }

  let entries: string[];
  try {
    entries = await fs.readdir(absoluteDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !create) {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries.map((entry) => fs.rm(path.join(absoluteDir, entry), { recursive: true, force: true }))
  );
}

function assertSafeManagedRelativeDir(relativeDir: string, label: string): void {
  const normalizedRelativeDir = path.normalize(relativeDir);
  const segments = relativeDir.split(/[\\/]+/);

  if (
    relativeDir.length === 0 ||
    normalizedRelativeDir === '.' ||
    path.isAbsolute(relativeDir) ||
    segments.includes('..')
  ) {
    throw new Error(
      `${label} path must be a managed subdirectory below the base directory; refusing to clear "${relativeDir}"`
    );
  }
}

async function assertManagedDirectoryPathIsSymlinkSafe(options: {
  baseDir: string;
  absoluteDir: string;
  label: string;
}): Promise<void> {
  const componentChain: string[] = [];
  for (
    let current = options.absoluteDir;
    current !== options.baseDir && current !== path.dirname(current);
    current = path.dirname(current)
  ) {
    componentChain.push(current);
  }

  for (const component of componentChain) {
    try {
      const stat = await fs.lstat(component);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `${options.label} path contains a symlinked component (${component}); refusing to clear to avoid deleting outside the intended directory`
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }
}

/**
 * Expands the tilde (~) character at the start of a path to the user's home directory.
 * This function handles both "~" (home directory) and "~/path" (path within home directory).
 *
 * @param filePath - The path that may contain a leading tilde
 * @returns The path with tilde expanded to the home directory, or the original path if no tilde is present
 *
 * @example
 * expandTilde('~/Documents/file.txt') // Returns '/Users/username/Documents/file.txt'
 * expandTilde('~') // Returns '/Users/username'
 * expandTilde('/absolute/path') // Returns '/absolute/path' (unchanged)
 */
export function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    const homeDir = os.homedir();
    return filePath === '~' ? homeDir : path.join(homeDir, filePath.slice(2));
  }
  return filePath;
}
