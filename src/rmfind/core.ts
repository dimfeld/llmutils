/**
 * Core logic for finding files based on various criteria (globs, grep, AI query).
 */
import path from 'node:path';
import { globFiles, grepFor } from '../common/file_finder.ts';
import { debugLog } from '../logging.ts';
import { generateGrepTermsFromQuery } from './generate_grep_terms.ts';
import { filterFilesWithQuery, RelevantFile } from './llm_file_filter.ts';

/**
 * Options for configuring the file finding process.
 */
export interface RmfindOptions {
  baseDir: string;
  globs: string[]; // Corresponds to positional arguments
  ignoreGlobs?: string[];
  grepPatterns?: string[];
  query?: string;
  wholeWord?: boolean;
  expand?: boolean;
  model: string; // Default model for unspecified AI tasks
  classifierModel: string; // Model specifically for classifying files based on query
  grepGeneratorModel: string; // Model specifically for generating grep patterns from query
  debug: boolean;
  quiet: boolean;
}

/**
 * Result of the file finding process.
 */
export interface RmfindResult {
  files: string[]; // Absolute paths of the found files
  // TODO: Potentially add relevance scores or other metadata later
}

/**
 * Finds files based on the provided options.
 */
export async function findFilesCore(options: RmfindOptions): Promise<RmfindResult> {
  const {
    baseDir,
    globs,
    ignoreGlobs,
    grepPatterns: initialGrepPatterns,
    query,
    wholeWord,
    expand,
    model,
    classifierModel,
    grepGeneratorModel,
    debug,
    quiet,
  } = options;

  // 2. Find Initial Files (Globbing or Grepping)
  let foundFiles: string[] = [];
  const hasGlobs = globs.length > 0;
  let grep = initialGrepPatterns ?? [];
  let hasGrep = grep.length > 0;
  const hasQuery = !!query;

  if (!hasGlobs && !hasGrep && !hasQuery) {
    // This case should ideally be caught by the CLI wrapper, but handle defensively
    console.error('Error: No globs, directories, grep patterns, or query provided.');
    return { files: [] };
  }

  try {
    // Generate grep terms from query if no grep terms are provided
    if (query && !hasGrep) {
      grep = await generateGrepTermsFromQuery(grepGeneratorModel, query);
      hasGrep = grep.length > 0;

      if (!quiet) {
        // Use console.warn directly as this is user-facing info, not debug log
        console.warn(`Generated grep terms: ${grep.join(', ')}\n`);
      }
    }

    if (hasGlobs) {
      debugLog(`Globbing patterns: ${globs.join(', ')} with ignore: ${ignoreGlobs?.join(', ')}`);
      foundFiles = await globFiles(baseDir, globs, ignoreGlobs);
      debugLog(`Found ${foundFiles.length} files via globbing.`);
      // If grep is specified or generated, filter the globbed files
      if (hasGrep) {
        debugLog(
          `Grepping within ${foundFiles.length} globbed files for patterns: ${grep.join(', ')}`
        );
        foundFiles = await grepFor(baseDir, grep, foundFiles, expand ?? false, wholeWord ?? false);
        debugLog(`Found ${foundFiles.length} files after grep filtering.`);
      }
    } else if (hasGrep) {
      // Only grep is specified or generated, search the base directory
      debugLog(`Grepping base directory for patterns: ${grep.join(', ')}`);
      foundFiles = await grepFor(baseDir, grep, undefined, expand ?? false, wholeWord ?? false);
      debugLog(`Found ${foundFiles.length} files via grep.`);
    }
  } catch (error) {
    console.error(`Error finding files: ${(error as Error).toString()}`);
    // Propagate the error or return empty? Let's return empty for now.
    return { files: [] };
  }

  // 3. Filter files with natural language query if provided
  if (query && foundFiles.length > 0) {
    let aiFilteredResults: RelevantFile[] = await filterFilesWithQuery(
      classifierModel,
      query,
      baseDir,
      foundFiles
    );
    // Ensure paths are absolute (filterFilesWithQuery should already return absolute paths)
    foundFiles = aiFilteredResults.map((file) => path.resolve(baseDir, file.filename));
    debugLog(`Filtered to ${foundFiles.length} files with query.`);
  }

  // Ensure all paths are absolute before returning
  const absoluteFiles = foundFiles.map((f) => path.resolve(baseDir, f));

  return { files: absoluteFiles };
}
