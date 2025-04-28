import * as path from 'node:path';
import * as os from 'node:os';
import glob from 'fast-glob';
import matter from 'gray-matter';
import micromatch from 'micromatch';
import { debugLog } from '../logging';

/**
 * Represents a parsed Markdown Domain Configuration (MDC) file.
 */
export interface MdcFile {
  /** Absolute path to the MDC file. */
  filePath: string;
  /** The main content of the file, excluding the frontmatter. */
  content: string;
  /** Parsed frontmatter data. */
  data: {
    description?: string;
    globs?: string | string[];
    grep?: string | string[];
    type?: 'docs' | 'rules' | string; // Allow 'docs', 'rules', or other custom types
    name?: string;
    // Allow other potential metadata fields
    [key: string]: any;
  };
}

/**
 * Parses a single MDC file, extracting frontmatter and content.
 * Uses Bun.file for reading.
 *
 * @param filePath Absolute path to the MDC file.
 * @returns A Promise resolving to the parsed MdcFile object, or null if parsing fails or the file is invalid.
 */
export async function parseMdcFile(filePath: string): Promise<MdcFile | null> {
  try {
    const fileContent = await Bun.file(filePath).text();
    const { data, content } = matter(fileContent);

    // Basic validation: ensure data is an object (frontmatter exists)
    if (typeof data !== 'object' || data === null) {
      debugLog(`[MDC] Invalid or missing frontmatter in ${filePath}`);
      return null;
    }

    return {
      filePath: path.resolve(filePath), // Ensure absolute path
      content: content.trim(),
      data: data,
    };
  } catch (error: any) {
    // Handle file read errors (e.g., ENOENT from Bun.file) or parsing errors from gray-matter
    console.warn(`[MDC] Error processing file ${filePath}: ${error}`);
    return null;
  }
}

/**
 * Finds all .mdc files in standard project and user configuration locations.
 *
 * @param gitRoot The absolute path to the git repository root.
 * @returns A Promise resolving to an array of absolute file paths to the found .mdc files.
 */
export async function findMdcFiles(gitRoot: string): Promise<string[]> {
  const projectRulesDir = path.join(gitRoot, '.cursor/rules');
  const userRulesDir = path.join(os.homedir(), '.config/rmfilter/rules');

  const searchPatterns = [
    path.join(projectRulesDir, '**/*.mdc').replace(/\\/g, '/'), // Normalize for glob
    path.join(userRulesDir, '**/*.mdc').replace(/\\/g, '/'), // Normalize for glob
  ];

  const files = await glob(searchPatterns, { absolute: true, onlyFiles: true, dot: true });
  debugLog(`[MDC] Found MDC files: ${files.join(', ')}`);
  return files;
}

/**
 * Normalizes input that can be undefined, a single string, or an array of strings
 * into an array of non-empty, trimmed strings.
 *
 * @param input The input value (string | string[] | undefined).
 * @returns An array of cleaned strings.
 */
function normalizeArrayInput(input: string | string[] | undefined): string[] {
  if (!input) {
    return [];
  }
  const arr = Array.isArray(input) ? input : [input];
  return arr
    .flatMap((s) => s.split(','))
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s) => s.length > 0);
}

/**
 * Filters a list of parsed MDC files based on rules (globs, grep) matching against active source files.
 *
 * @param mdcFiles An array of parsed `MdcFile` objects.
 * @param activeSourceFiles An array of *absolute paths* to the source files selected by the main `rmfilter` process.
 * @param gitRoot The absolute path to the git repository root.
 * @returns A promise resolving to an array of `MdcFile` objects that meet the inclusion criteria.
 */
export async function filterMdcFiles(
  mdcFiles: MdcFile[],
  activeSourceFiles: string[],
  gitRoot: string
): Promise<MdcFile[]> {
  // Convert absolute source file paths to relative paths (using POSIX separators) for glob matching.
  const relativeSourceFiles = activeSourceFiles.map((absPath) =>
    path.relative(gitRoot, absPath).replace(/\\/g, '/')
  );

  const includedFiles = await Promise.all(
    mdcFiles.map(async (mdcFile) => {
      const globPatterns = normalizeArrayInput(mdcFile.data.globs).map((pattern) => {
        if (pattern.includes('/')) {
          return pattern;
        } else {
          return `**/${pattern}`;
        }
      });
      const grepTerms = normalizeArrayInput(mdcFile.data.grep);

      // 1. Default Inclusion Check: Include if no globs or grep terms are specified.
      if (globPatterns.length === 0 && grepTerms.length === 0) {
        debugLog(`[MDC Filter] Including '${mdcFile.filePath}' (default)`);
        return mdcFile;
      }

      // 2. Glob Matching (only if not default-included)
      if (globPatterns.length > 0) {
        if (!relativeSourceFiles.some((file) => micromatch.isMatch(file, globPatterns))) {
          debugLog(`[MDC Filter] Excluding '${mdcFile.filePath}' (no glob match)`);
          return null;
        }
      }

      // 3. Grep Matching (only if not default-included or glob-included)
      if (grepTerms.length > 0) {
        const lowerCaseGrepTerms = grepTerms.map((term) => term.toLowerCase());
        let grepMatch = false;
        for (const absoluteSourceFilePath of activeSourceFiles) {
          try {
            const content = await Bun.file(absoluteSourceFilePath).text();
            const lowerCaseContent = content.toLowerCase();
            if (lowerCaseGrepTerms.some((term) => lowerCaseContent.includes(term))) {
              debugLog(
                `[MDC Filter] Including '${mdcFile.filePath}' (grep match in ${absoluteSourceFilePath})`
              );
              grepMatch = true;
              break;
            }
          } catch (error: any) {
            // Log error reading source file but continue checking other source files for this MDC
            debugLog(
              `[MDC Filter] Warning: Could not read source file ${absoluteSourceFilePath} for grep matching: ${error.message}`
            );
          }
        }

        if (!grepMatch) {
          return null;
        }
      }

      return mdcFile;
    })
  );

  return includedFiles.filter((file) => file != null);
}
