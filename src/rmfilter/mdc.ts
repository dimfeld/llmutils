import * as path from 'node:path';
import * as os from 'node:os';
import glob from 'fast-glob';
import micromatch from 'micromatch';
import { debugLog, warn } from '../logging';

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
    alwaysApply?: boolean;
    // Allow other potential metadata fields
    [key: string]: any;
  };
}

/**
 * Parses a single MDC file, extracting frontmatter and content.
 * Uses a custom parser to handle unquoted globs and other fields.
 *
 * @param filePath Absolute path to the MDC file.
 * @returns A Promise resolving to the parsed MdcFile object, or null if parsing fails or the file is invalid.
 */
export async function parseMdcFile(filePath: string): Promise<MdcFile | null> {
  try {
    const fileContent = await Bun.file(filePath).text();
    let data: { [key: string]: any } = {};
    let content = fileContent;

    // Check for frontmatter (delimited by ---)
    const frontMatterMatch = fileContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (frontMatterMatch) {
      const frontMatter = frontMatterMatch[1];
      content = frontMatterMatch[2].trim();

      // Parse frontmatter lines
      const lines = frontMatter.split('\n');
      for (const line of lines) {
        if (line.trim() === '') continue;
        // Split on the first colon to separate key and value
        const firstColonIndex = line.indexOf(':');
        if (firstColonIndex === -1) {
          debugLog(`[MDC] Invalid frontmatter line in ${filePath}: ${line}`);
          continue;
        }
        const key = line.slice(0, firstColonIndex).trim();
        let value: any = line.slice(firstColonIndex + 1).trim();

        // Handle specific fields
        if (key === 'globs' || key === 'grep') {
          // Split comma-separated values and trim
          value = value
            .split(',')
            .map((v: string) => {
              let trimmed = v.trim();
              // Strip leading/trailing quotes if present
              if (
                (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
                (trimmed.startsWith("'") && trimmed.endsWith("'"))
              ) {
                trimmed = trimmed.slice(1, -1);
              }
              return trimmed;
            })
            .filter((v: string) => v);
        } else if (key === 'alwaysApply') {
          // Convert to boolean
          value = value.toLowerCase() === 'true';
        }
        data[key] = value;
      }
    }

    // Basic validation: ensure data is an object
    if (typeof data !== 'object' || data === null) {
      debugLog(`[MDC] Invalid or missing frontmatter in ${filePath}`);
      return null;
    }

    return {
      filePath: path.resolve(filePath), // Ensure absolute path
      content,
      data,
    };
  } catch (err: any) {
    // Handle file read errors (e.g., ENOENT from Bun.file)
    warn(`[MDC] Error processing file ${filePath}: ${err}`);
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
 * Filters a list of parsed MDC files based on rules (globs, grep) and alwaysApply flag.
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

      // 1. Always Apply Check
      if (mdcFile.data.alwaysApply === true) {
        debugLog(`[MDC Filter] Including '${mdcFile.filePath}' (alwaysApply: true)`);
        return mdcFile;
      }

      // 2. Handle alwaysApply: false or absent
      const hasRules = globPatterns.length > 0 || grepTerms.length > 0;
      if (mdcFile.data.alwaysApply === false) {
        if (!hasRules) {
          debugLog(`[MDC Filter] Excluding '${mdcFile.filePath}' (alwaysApply: false, no rules)`);
          return null;
        }
      } else if (!hasRules) {
        // alwaysApply absent and no rules → include by default
        debugLog(`[MDC Filter] Including '${mdcFile.filePath}' (no rules, default include)`);
        return mdcFile;
      }

      // 3. Glob Matching
      if (globPatterns.length > 0) {
        if (!relativeSourceFiles.some((file) => micromatch.isMatch(file, globPatterns))) {
          debugLog(`[MDC Filter] Excluding '${mdcFile.filePath}' (no glob match)`);
          return null;
        }
      }

      // 4. Grep Matching
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
          } catch (err: any) {
            // Log error reading source file but continue checking other source files for this MDC
            debugLog(
              `[MDC Filter] Warning: Could not read source file ${absoluteSourceFilePath} for grep matching: ${err.message}`
            );
          }
        }

        if (!grepMatch) {
          debugLog(`[MDC Filter] Excluding '${mdcFile.filePath}' (no grep match)`);
          return null;
        }
      }

      return mdcFile;
    })
  );

  return includedFiles.filter((file) => file != null);
}
