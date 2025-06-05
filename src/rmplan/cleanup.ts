import path from 'node:path';
import { debugLog, error, log } from '../logging.ts';
import { CURRENT_DIFF, getChangedFiles } from '../rmfilter/additional_docs.ts';
import { getGitRoot } from '../common/git.ts';

const doubleSlash = /\/\/\s*.*$/;
const slashStar = /\/\*[\s\S]*?\*\/$/;
const hash = /#\s*.*$/;
// Gemini sometimes adds comments like {} which are not valid syntax
const invalidSvelteTemplateComment = /\{\/\*([\s\S]+)\*\/\}/;

const commentPatterns: { [ext: string]: RegExp[] } = {
  '.svelte': [invalidSvelteTemplateComment, doubleSlash, slashStar],
  '.tsx': [doubleSlash, slashStar],
  '.jsx': [doubleSlash, slashStar],
  '.js': [doubleSlash, slashStar],
  '.ts': [doubleSlash, slashStar],
  '.py': [hash],
  '.rs': [doubleSlash, slashStar],
  '.go': [doubleSlash, slashStar],
  '.kt': [doubleSlash, slashStar],
  '.swift': [doubleSlash, slashStar],
  '.c': [doubleSlash, slashStar],
  '.h': [doubleSlash, slashStar],
  '.hpp': [doubleSlash, slashStar],
  '.cpp': [doubleSlash, slashStar],
  '.cc': [doubleSlash, slashStar],
};

/**
 * Cleans end-of-line comments from a string based on file extension
 * @param content The file content to clean
 * @param ext The file extension (e.g., '.ts', '.py')
 * @returns Object containing cleaned content and number of lines cleaned
 */
export function cleanComments(
  content: string,
  ext: string
): { cleanedContent: string; linesCleaned: number } | undefined {
  const patterns = commentPatterns[ext];
  if (!patterns?.length) {
    return;
  }

  let lines = content.split('\n');
  let linesCleaned = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Check each pattern for this extension
    for (const pattern of commentPatterns[ext]) {
      // Special case for invalid Svelte template comments since they happen on standalone lines and can be fixed.
      const match = line.match(pattern);
      if (match && pattern === invalidSvelteTemplateComment) {
        let startIndex = match.index!;
        lines[i] = lines[i].slice(0, startIndex) + `<!--${match[1]}-->`;
        linesCleaned++;
        break;
      }

      // For regular comments, check if there's code before the comment
      if (match && match.index !== undefined) {
        // Get the part before the comment
        const beforeComment = line.slice(0, match.index);
        if (beforeComment.at(-1) !== ' ') {
          // this isn't actually an EOL comment
          continue;
        }

        const trimmedBefore = beforeComment.trim();

        // Only remove if there's actual code before the comment (not just whitespace)
        if (trimmedBefore.length > 0) {
          lines[i] = beforeComment.trimEnd();
          linesCleaned++;
          break;
        }
      }
    }
  }

  if (!linesCleaned) {
    return;
  }

  return { cleanedContent: lines.join('\n'), linesCleaned };
}

/**
 * Removes end-of-line comments from supported file types
 * @param baseBranch Optional base branch for diff comparison when no files are provided
 * @param files Optional list of specific files to clean
 */
export async function cleanupEolComments(baseBranch?: string, files?: string[]): Promise<void> {
  const gitRoot = await getGitRoot();
  if (!gitRoot) {
    error('Could not determine Git repository root');
    return;
  }

  let targetFiles: string[];
  if (files && files.length > 0) {
    // Use provided files, ensuring they're resolved relative to git root
    targetFiles = files.map((file) => path.resolve(process.cwd(), file));
    // Verify files exist
    targetFiles = (
      await Promise.all(
        targetFiles.map(async (file) => ((await Bun.file(file).exists()) ? file : null))
      )
    ).filter((file): file is string => file !== null);
    if (targetFiles.length === 0) {
      log('No valid files provided');
      return;
    }
  } else {
    // Fall back to changed files
    targetFiles = await getChangedFiles(gitRoot, baseBranch || CURRENT_DIFF);
    if (targetFiles.length === 0) {
      log('No changed files found');
      return;
    }
    // Convert to absolute paths
    targetFiles = targetFiles.map((file) => path.resolve(gitRoot, file));
  }

  const supportedExtensions = Object.keys(commentPatterns);

  for (const fullPath of targetFiles) {
    const relativePath = path.relative(gitRoot, fullPath);
    const ext = path.extname(fullPath);
    if (!supportedExtensions.includes(ext)) {
      debugLog(`Skipping file with unsupported extension: ${relativePath}`);
      continue;
    }

    debugLog(`${relativePath}: Cleaning end-of-line comments`);

    let content = await Bun.file(fullPath).text();
    const result = cleanComments(content, ext);

    if (result) {
      const { cleanedContent, linesCleaned } = result;
      await Bun.write(fullPath, cleanedContent);
      log(`${relativePath}: Cleaned ${linesCleaned} end-of-line comments`);
    }
  }
}
