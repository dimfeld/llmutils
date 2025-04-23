#!/usr/bin/env bun
import * as changeCase from 'change-case';
import { globby } from 'globby';
import path from 'node:path';
import { debug, logSpawn } from '../rmfilter/utils.ts';

/**
 * Finds files matching glob patterns.
 * @param baseDir The base directory for resolving relative paths and globs.
 * @param positionals An array of glob patterns or directory paths.
 * @param ignoreGlobs An array of glob patterns to ignore.
 * @returns A promise that resolves to an array of absolute file paths.
 */
export async function globFiles(
  baseDir: string,
  positionals: string[],
  ignoreGlobs: string[] | undefined
): Promise<string[]> {
  if (debug) {
    console.time(`Globbing ${positionals.join(', ')}`);
  }

  let withDirGlobs = await Promise.all(
    positionals.map(async (p) => {
      let isDir = await Bun.file(path.resolve(baseDir, p))
        .stat()
        .then((d) => d.isDirectory())
        .catch(() => false);

      let replaced = p.replaceAll(/\[|\]/g, '\\$&');
      // If it's a directory, append /** to search recursively
      return isDir ? `${replaced}/**` : replaced;
    })
  );

  let processedIgnoreGlobs = await Promise.all(
    (ignoreGlobs || []).map(async (p) => {
      let isDir = await Bun.file(path.resolve(baseDir, p))
        .stat()
        .then((d) => d.isDirectory())
        .catch(() => false);

      let replaced = p.replaceAll(/\[|\]/g, '\\$&');
      return isDir ? `${replaced}/**` : replaced;
    })
  );

  processedIgnoreGlobs.push('.git/**', '.jj/**');

  const files = await globby(withDirGlobs, {
    cwd: baseDir,
    onlyFiles: true,
    absolute: true, // Return absolute paths
    dot: true,
    followSymbolicLinks: false,
    ignore: processedIgnoreGlobs.length ? processedIgnoreGlobs : undefined,
    ignoreFiles: ['**/.gitignore', '**/.repomixignore'],
  });

  if (debug) {
    console.timeEnd(`Globbing ${positionals.join(', ')}`);
  }
  return files;
}

export function expandPattern(pattern: string): string[] {
  return [changeCase.snakeCase(pattern), changeCase.camelCase(pattern)];
}

/**
 * Greps for patterns within a set of files or a base directory.
 * @param baseDir The base directory for searching if sourceFiles is empty.
 * @param patterns An array of patterns to grep for.
 * @param sourceFiles An optional array of specific files to search within. If empty, searches baseDir.
 * @param expand Whether to expand patterns (snake_case, camelCase).
 * @param wholeWord Whether to match whole words only.
 * @returns A promise that resolves to an array of absolute file paths containing matches.
 */
export async function grepFor(
  baseDir: string,
  patterns: string[],
  sourceFiles: string[] | undefined,
  expand: boolean,
  wholeWord: boolean
): Promise<string[]> {
  if (!patterns.length) {
    // If no patterns, return sourceFiles if provided, otherwise empty
    return sourceFiles || [];
  }

  if (sourceFiles && sourceFiles.length > 512) {
    let chunks: string[][] = [];
    for (let i = 0; i < sourceFiles.length; i += 512) {
      chunks.push(sourceFiles.slice(i, i + 512));
    }
    const results = await Promise.all(
      chunks.map((chunk) => grepFor(baseDir, patterns, chunk, expand, wholeWord))
    );
    return results.flat();
  }

  const processedPatterns = patterns.flatMap((p) => p.split(','));
  const finalPatterns = expand ? processedPatterns.flatMap(expandPattern) : processedPatterns;

  const args = finalPatterns.flatMap((p) => ['-e', p]);

  const repomixIgnorePath = path.join(baseDir, '.repomixignore');
  if (await Bun.file(repomixIgnorePath).exists()) {
    args.push(`--ignore-file=${repomixIgnorePath}`);
  }

  if (wholeWord) {
    args.push('--word-regexp');
  }

  // Determine search paths: use provided sourceFiles or the baseDir
  const searchPaths = sourceFiles && sourceFiles.length > 0 ? sourceFiles : [baseDir];

  // Check if all patterns are lowercase for case-insensitive search
  const lowercase = finalPatterns.every((a) => a.toLowerCase() === a);
  if (lowercase) {
    args.push('-i');
  }

  const proc = logSpawn(['rg', '--files-with-matches', ...args, ...searchPaths], { cwd: baseDir });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 && exitCode !== 1) {
    // rg exits 1 if no matches found
    const stderr = await new Response(proc.stderr).text();
    console.error(`rg command failed with exit code ${exitCode}:\n${stderr}`);
    return [];
  }

  const files = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    // rg returns paths relative to cwd (baseDir), resolve them
    .map((file) => path.resolve(baseDir, file));

  return files;
}
