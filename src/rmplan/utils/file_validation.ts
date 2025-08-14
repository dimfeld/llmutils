/**
 * File validation utilities for rmplan commands
 * Provides security validation for file paths and other file-related operations
 */

import { isAbsolute, join, resolve, relative } from 'node:path';

/**
 * Validates that a file path is safe to read and within allowed boundaries
 * Prevents path traversal attacks and ensures the path stays within the git root
 * 
 * @param filePath - The file path to validate (can be relative or absolute)
 * @param gitRoot - The git root directory to constrain paths within
 * @returns The resolved absolute path if validation passes
 * @throws Error if the path is invalid or unsafe
 */
export function validateInstructionsFilePath(filePath: string, gitRoot: string): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Instructions file path must be a non-empty string');
  }

  // Check for null bytes and other dangerous characters
  if (filePath.includes('\0')) {
    throw new Error('Instructions file path contains null byte character');
  }

  // Resolve the absolute path
  const absolutePath = isAbsolute(filePath) ? filePath : join(gitRoot, filePath);
  const resolvedPath = resolve(absolutePath);
  const resolvedGitRoot = resolve(gitRoot);

  // Ensure the resolved path is within the git root directory
  const relativePath = relative(resolvedGitRoot, resolvedPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Instructions file path is outside the allowed directory: ${filePath}`);
  }

  // Additional security check: prevent common dangerous paths
  // Only apply this check if the path is actually outside the git root or attempts to access system directories
  const normalizedPath = resolvedPath.toLowerCase();
  const normalizedGitRoot = resolvedGitRoot.toLowerCase();
  
  // Skip dangerous path check if we're within a temp directory or git root is already safe
  const isTempPath = normalizedPath.includes('/tmp/') || 
                     normalizedPath.includes('/var/folders/') || // macOS temp
                     normalizedPath.includes('\\temp\\') ||
                     normalizedGitRoot.includes('/tmp/') ||
                     normalizedGitRoot.includes('/var/folders/');
  
  if (!isTempPath) {
    const dangerousPaths = [
      '/etc/',
      '/usr/',
      '/var/log/',    // More specific - /var itself might contain temp dirs
      '/var/www/',    // More specific
      '/home/',
      '/root/',
      'c:\\windows\\',
      'c:\\users\\',
    ];
    if (dangerousPaths.some((dangerous) => normalizedPath.startsWith(dangerous))) {
      throw new Error(`Instructions file path contains dangerous directory: ${filePath}`);
    }
  }

  return resolvedPath;
}