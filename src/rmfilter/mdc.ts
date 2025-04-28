import * as path from 'node:path';
import * as os from 'node:os';
import glob from 'fast-glob';
import matter from 'gray-matter';
import micromatch from 'micromatch'; // Although not used in this file yet, it's needed for filtering later
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
    debugLog(`[MDC] Error processing file ${filePath}: ${error.message}`);
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
