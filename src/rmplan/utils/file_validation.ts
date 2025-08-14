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
  const isTempPath =
    normalizedPath.includes('/tmp/') ||
    normalizedPath.includes('/var/folders/') || // macOS temp
    normalizedPath.includes('\\temp\\') ||
    normalizedGitRoot.includes('/tmp/') ||
    normalizedGitRoot.includes('/var/folders/');

  if (!isTempPath) {
    const dangerousPaths = [
      '/etc/',
      '/usr/',
      '/var/log/', // More specific - /var itself might contain temp dirs
      '/var/www/', // More specific
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

/**
 * Validates that a file path is safe for writing output files
 * Prevents path traversal attacks and ensures the path stays within the git root
 * Similar to validateInstructionsFilePath but optimized for output file validation
 *
 * @param filePath - The file path to validate (can be relative or absolute)
 * @param gitRoot - The git root directory to constrain paths within
 * @returns The resolved absolute path if validation passes
 * @throws Error if the path is invalid or unsafe
 */
export function validateOutputFilePath(filePath: string, gitRoot: string): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Output file path must be a non-empty string');
  }

  // Check for null bytes and other dangerous characters
  if (filePath.includes('\0')) {
    throw new Error('Output file path contains null byte character');
  }

  // Check for suspicious sequences that could indicate path traversal attempts
  if (filePath.includes('..')) {
    throw new Error('Output file path contains potentially dangerous path traversal sequence');
  }

  // Resolve the absolute path
  const absolutePath = isAbsolute(filePath) ? filePath : join(gitRoot, filePath);
  const resolvedPath = resolve(absolutePath);
  const resolvedGitRoot = resolve(gitRoot);

  // Ensure the resolved path is within the git root directory
  const relativePath = relative(resolvedGitRoot, resolvedPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Output file path is outside the allowed directory: ${filePath}`);
  }

  // Additional security check: prevent common dangerous paths
  const normalizedPath = resolvedPath.toLowerCase();
  const normalizedGitRoot = resolvedGitRoot.toLowerCase();

  // Skip dangerous path check if we're within a temp directory or git root is already safe
  const isTempPath =
    normalizedPath.includes('/tmp/') ||
    normalizedPath.includes('/var/folders/') || // macOS temp
    normalizedPath.includes('\\temp\\') ||
    normalizedGitRoot.includes('/tmp/') ||
    normalizedGitRoot.includes('/var/folders/');

  if (!isTempPath) {
    const dangerousPaths = [
      '/etc/',
      '/usr/',
      '/var/log/', // More specific - /var itself might contain temp dirs
      '/var/www/', // More specific
      '/home/',
      '/root/',
      'c:\\windows\\',
      'c:\\users\\',
    ];
    if (dangerousPaths.some((dangerous) => normalizedPath.startsWith(dangerous))) {
      throw new Error(`Output file path contains dangerous directory: ${filePath}`);
    }
  }

  return resolvedPath;
}

/**
 * Sanitizes text content for safe process input
 * Removes or escapes potentially dangerous sequences that could be used for command injection
 *
 * @param content - The content to sanitize
 * @returns The sanitized content
 */
export function sanitizeProcessInput(content: string): string {
  if (typeof content !== 'string') {
    throw new Error('Process input must be a string');
  }

  // Check for null bytes which can be used for command injection
  if (content.includes('\0')) {
    throw new Error('Process input contains null byte character');
  }

  // For PR descriptions, we mainly need to ensure the content doesn't contain
  // sequences that could break the gh command line parsing
  // The gh CLI with --body-file - reads from stdin, so it's already fairly safe,
  // but we still want to validate

  // Remove any control characters except for standard whitespace and newlines
  // eslint-disable-next-line no-control-regex
  const sanitized = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return sanitized;
}

/**
 * Validates CLI options to ensure they have expected types and values
 * Provides early validation to prevent runtime errors
 *
 * @param options - The options object to validate
 * @throws Error if validation fails
 */
export function validateDescriptionOptions(options: Record<string, unknown>): void {
  if (options.outputFile !== undefined) {
    if (typeof options.outputFile !== 'string') {
      throw new Error('--output-file must be a string path');
    }
    if (options.outputFile.trim() === '') {
      throw new Error('--output-file cannot be empty');
    }
  }

  if (options.copy !== undefined) {
    if (typeof options.copy !== 'boolean') {
      throw new Error('--copy must be a boolean flag');
    }
  }

  if (options.createPr !== undefined) {
    if (typeof options.createPr !== 'boolean') {
      throw new Error('--create-pr must be a boolean flag');
    }
  }
}
