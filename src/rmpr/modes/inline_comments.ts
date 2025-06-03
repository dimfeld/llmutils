import * as path from 'path';
import { findClosestMatches } from '../../editor/closest_match.ts';
import type { DetailedReviewComment } from '../types.ts';
import { basePrPrompt } from '../prompts.ts';
import { debugLog, error } from '../../logging.ts';
import { singleLineWithPrefix } from '../../common/formatting.ts';

export interface AiCommentInsertionResult {
  contentWithAiComments: string;
  errors: string[];
}

function addToMapList(map: Map<number, string[]>, key: number, values: string[]) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key)!.push(...values);
}

/**
 * Extracts the "after" state lines from diffForContext, including unchanged and added lines.
 */
function getAfterStateLines(diffForContext: DetailedReviewComment['diffForContext']): string[] {
  return diffForContext
    .filter((line) => line.content.startsWith(' ') || line.content.startsWith('+'))
    .map((line) => line.content.slice(1));
}

/**
 * Finds the best match for the comment's context in the original content, returning adjusted line numbers.
 * @param originalContent - The current file content
 * @param diffForContext - The diff context from the review comment
 * @param targetLineInFile - The 1-indexed line number from thread.line (may be null for outdated comments)
 * @param targetStartLineInFile - The 1-indexed start line number from thread.startLine (may be null)
 * @returns Adjusted 0-indexed line numbers for comment placement
 */
function findBestMatchLine(
  originalContent: string,
  diffForContext: DetailedReviewComment['diffForContext'],
  targetLineInFile: number | null,
  targetStartLineInFile: number | null
): { startLine: number; endLine: number } | null {
  const afterStateLines = getAfterStateLines(diffForContext);
  if (afterStateLines.length === 0) {
    // Fallback to line numbers if no valid context
    if (targetStartLineInFile !== null && targetLineInFile !== null) {
      // Convert from 1-indexed to 0-indexed
      return { startLine: targetStartLineInFile - 1, endLine: targetLineInFile - 1 };
    }
    return null;
  }

  const matches = findClosestMatches(originalContent, afterStateLines, {
    similarityThreshold: 0.8,
    maxMatches: 5,
  });

  if (matches.length === 0) {
    // No match found, return null
    return null;
  }

  // If we have a target line, use it to find the closest match
  if (targetLineInFile !== null) {
    // Convert 1-indexed to 0-indexed for comparison with match results
    const targetLine0Indexed = targetLineInFile - 1;

    let bestMatch = matches[0];
    let minDistance = Math.abs(bestMatch.startLine - targetLine0Indexed);

    for (const match of matches.slice(1)) {
      const distance = Math.abs(match.startLine - targetLine0Indexed);
      // Prefer match with higher score, or if scores are equal, the one with smaller distance
      if (
        match.score > bestMatch.score ||
        (match.score === bestMatch.score && distance < minDistance)
      ) {
        bestMatch = match;
        minDistance = distance;
      }
    }

    // Continue with the best match found and adjust based on diff context
    // Adjust line numbers based on the comment's position within the diff context
    let targetIndex = diffForContext.findIndex(
      (diffLine) => diffLine.newLineNumber === targetLineInFile
    );

    // If no exact match, fallback to using the line numbers relative to the match
    if (targetIndex === -1) {
      debugLog(`No matching newLineNumber found for line ${targetLineInFile} in diffForContext`);
      return {
        startLine: bestMatch.startLine,
        endLine: bestMatch.endLine,
      };
    }

    // The bestMatch already gives us the location in the file where the diff context was found
    // We need to adjust within that match based on where the target line is within the diff context
    const contextStartLineInDiff = diffForContext[0].newLineNumber;
    const targetOffsetInContext = targetLineInFile - contextStartLineInDiff;

    // The target line is at bestMatch.startLine + targetOffsetInContext
    const adjustedEndLine = bestMatch.startLine + targetOffsetInContext;

    // For block comments, calculate the start line
    const adjustedStartLine =
      targetStartLineInFile !== null &&
      targetLineInFile !== null &&
      targetStartLineInFile !== targetLineInFile
        ? adjustedEndLine - (targetLineInFile - targetStartLineInFile)
        : adjustedEndLine;

    debugLog(`Adjusted lines: startLine=${adjustedStartLine}, endLine=${adjustedEndLine}`);

    return {
      startLine: adjustedStartLine,
      endLine: adjustedEndLine,
    };
  } else {
    // No target line available (outdated comment), just use the highest scoring match
    let bestMatch = matches[0];
    for (const match of matches.slice(1)) {
      if (match.score > bestMatch.score) {
        bestMatch = match;
      }
    }

    return {
      startLine: bestMatch.startLine,
      endLine: bestMatch.endLine,
    };
  }
}

type LineCommenter = (text: string) => string;

function getLineCommenterForFile(
  filePath: string,
  firstLineOfFile?: string,
  prefixOnly = false
): LineCommenter {
  const extension = path.extname(filePath).toLowerCase();
  const baseName = path.basename(filePath).toLowerCase();

  switch (extension) {
    case '.js':
    case '.jsx':
    case '.ts':
    case '.tsx':
    case '.mjs':
    case '.cjs':
    case '.mts':
    case '.cts':
    case '.go':
    case '.java':
    case '.kt':
    case '.kts':
    case '.scala':
    case '.swift':
    case '.c':
    case '.cpp':
    case '.h':
    case '.hpp':
    case '.cs':
    case '.rs':
    case '.dart':
    case '.gd': // GDScript (Godot)
      return (text: string) => `// ${text}`;
    case '.py':
    case '.rb':
    case '.pl':
    case '.sh':
    case '.bash':
    case '.zsh':
    case '.yaml':
    case '.yml':
    case '.r':
    case '.ps1': // PowerShell
    case '.conf':
    case '.properties':
    case '.ini':
    case '.tf': // Terraform
      return (text: string) => `# ${text}`;
    case '.html':
    case '.htm':
    case '.xml':
    case '.xsl':
    case '.xslt':
    case '.vue':
    case '.astro':
    case '.md':
    case '.svg':
      return prefixOnly ? (text: string) => `<!-- ${text}` : (text: string) => `<!-- ${text} -->`;
    case '.css':
    case '.scss':
    case '.less':
    case '.styl': // Stylus
      return prefixOnly ? (text: string) => `/* ${text}` : (text: string) => `/* ${text} */`;
    case '.lua':
      return (text: string) => `-- ${text}`;
    case '.sql':
      return (text: string) => `-- ${text}`;
    // Svelte is handled specially within insertAiCommentsIntoFileContent due to context-dependent prefixing
    // No specific case for .svelte here, it will fall to default or filename check if not handled by caller.

    default:
      // Handle common filenames without extensions
      if (!extension) {
        if (baseName === 'dockerfile') return (text: string) => `# ${text}`;
        if (baseName === 'makefile') return (text: string) => `# ${text}`;
        if (baseName === 'jenkinsfile' || baseName === 'pipeline')
          return (text: string) => `// ${text}`; // Groovy

        // Shebang check for script files without extensions
        if (firstLineOfFile?.startsWith('#!')) {
          if (firstLineOfFile.includes('python')) return (text: string) => `# ${text}`;
          if (
            firstLineOfFile.includes('bash') ||
            firstLineOfFile.includes('sh') ||
            firstLineOfFile.includes('zsh')
          )
            return (text: string) => `# ${text}`;
          if (firstLineOfFile.includes('perl')) return (text: string) => `# ${text}`;
          if (firstLineOfFile.includes('ruby')) return (text: string) => `# ${text}`;
          if (firstLineOfFile.includes('node')) return (text: string) => `// ${text}`;
        }
      }
      // Fallback for unknown or unhandled file types
      return (text: string) => `// ${text}`; // Defaulting to JS/TS style comments
  }
}

/**
 * Inserts AI-prefixed comments and markers into file content.
 * Line numbers in comments (originalLine, originalStartLine) are 1-based.
 */
export function insertAiCommentsIntoFileContent(
  originalContent: string,
  commentsForFile: DetailedReviewComment[],
  filePath: string
): AiCommentInsertionResult {
  debugLog('insertAiCommentsIntoFileContent', filePath);

  // If the file already has AI comments left over from a cancelled run, remove them
  originalContent = removeAiCommentMarkers(originalContent, filePath);

  const lines = originalContent.split('\n');
  const newLines: string[] = [];

  const insertBefore = new Map<number, string[]>();
  const insertAfter = new Map<number, string[]>();

  const errors: string[] = [];

  // The file may have changed since it was reviewed, so process the comments to determine
  // adjusted line numbers.
  const commentsWithAdjustedLines = commentsForFile
    .map((comment) => {
      const startLine = comment.thread.startLine;
      const endLine = comment.thread.line;

      debugLog({
        index1Start: startLine,
        index1End: endLine,
      });
      const bestMatchResult = findBestMatchLine(
        originalContent,
        comment.diffForContext,
        // Pass 1-indexed line numbers directly
        endLine,
        startLine
      );

      if (!bestMatchResult) {
        let lineRange =
          startLine && endLine && startLine !== endLine
            ? `${startLine}-${endLine}`
            : (endLine ?? 'unknown');
        errors.push(
          singleLineWithPrefix(
            `Could not find matching comment content from ${filePath}:${lineRange}: `,
            comment.comment.body
          )
        );
        return;
      }

      return {
        ...comment,
        startLine: bestMatchResult.startLine,
        endLine: bestMatchResult.endLine,
      };
    })
    .filter((c) => c != null);

  // Sort comments by adjusted startLine, then endLine, then ID for stability
  const sortedComments = [...commentsWithAdjustedLines].sort((a, b) => {
    const startA = a.startLine;
    const startB = b.startLine;
    if (startA !== startB) {
      return startA - startB;
    }
    return a.comment.id.localeCompare(b.comment.id);
  });

  const defaultPrefixer = getLineCommenterForFile(
    filePath,
    lines.length > 0 ? lines[0] : undefined
  );
  const svelteJsPrefixer = (text: string) => `// ${text}`;
  const svelteHtmlPrefixer = (text: string) => `<!-- ${text} -->`;

  const useScriptTag = path.extname(filePath).toLowerCase() === '.svelte';
  const scriptEndTagIndex = useScriptTag
    ? lines.findIndex((line) => line.includes('</script>'))
    : -1;

  for (const comment of sortedComments) {
    let currentPrefixer: LineCommenter = defaultPrefixer;

    if (useScriptTag) {
      // For Svelte files, check if the adjusted line is in the script or template section

      // If no </script> tag or comment is after it, use HTML style. Otherwise JS style.
      if (scriptEndTagIndex === -1 || comment.startLine >= scriptEndTagIndex) {
        currentPrefixer = svelteHtmlPrefixer;
      } else {
        currentPrefixer = svelteJsPrefixer;
      }
    }

    const commentBody = comment.cleanedComment || comment.comment.body;
    const aiPrefixedBodyLines = commentBody
      .split('\n')
      .map((line) => currentPrefixer(`AI: ${line}`));

    // A comment is considered a "block" comment needing markers if startLine is specified and differs from endLine
    const { startLine, endLine } = comment;
    const isBlockComment = startLine !== endLine;

    if (isBlockComment) {
      const startMarkerLine = currentPrefixer(`AI_COMMENT_START`);
      const endMarkerLine = currentPrefixer(`AI_COMMENT_END`);

      debugLog(`Block comment: startLine=${startLine}, endLine=${endLine}`);
      addToMapList(insertBefore, startLine, [startMarkerLine, ...aiPrefixedBodyLines]);
      addToMapList(insertAfter, endLine, [endMarkerLine]);
    } else {
      // Single-line comment: insert before the startLine
      addToMapList(insertBefore, startLine, aiPrefixedBodyLines);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (insertBefore.has(i)) {
      debugLog(`Inserting AI comment marker before line ${i + 1}`);
      newLines.push(...insertBefore.get(i)!);
    }
    newLines.push(lines[i]);
    if (insertAfter.has(i)) {
      debugLog(`Inserting AI comment marker after line ${i + 1}`);
      newLines.push(...insertAfter.get(i)!);
    }
  }

  // Special handling for empty original content to ensure comments are placed correctly.
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
    if (insertBefore.has(0)) {
      newLines.push(...insertBefore.get(0)!);
    }
    if (insertAfter.has(0) && lines.length <= 1) {
      newLines.push(...insertAfter.get(0)!);
    }
  }

  return { contentWithAiComments: newLines.join('\n'), errors };
}

export function removeAiCommentMarkers(fileContent: string, filePath: string): string {
  const lines = fileContent.split('\n');
  const prefixer = getLineCommenterForFile(filePath, lines.length > 0 ? lines[0] : undefined, true);
  const isSvelte = path.extname(filePath).toLowerCase() === '.svelte';
  const scriptEndTagIndex = isSvelte ? lines.findIndex((line) => line.includes('</script>')) : -1;

  const candidates = [prefixer('AI_COMMENT_START'), prefixer('AI_COMMENT_END'), prefixer('AI:')];

  const cleanedLines = lines.filter((line, index) => {
    const trimmed = line.trim();

    // Handle Svelte: check if line is in script or template section
    let theseCandidates = candidates;
    const tryOtherPrefixer = isSvelte && (scriptEndTagIndex === -1 || index >= scriptEndTagIndex);
    if (tryOtherPrefixer) {
      let thisPrefixer = (text: string) => `<!-- ${text}`;
      theseCandidates = [
        thisPrefixer('AI_COMMENT_START'),
        thisPrefixer('AI_COMMENT_END'),
        thisPrefixer('AI:'),
      ];
    }

    if (theseCandidates.some((candidate) => trimmed.startsWith(candidate))) {
      return false;
    }

    // For Svelte, also check the other prefixer to handle mixed script/template comments
    if (tryOtherPrefixer && candidates.some((candidate) => trimmed.startsWith(candidate))) {
      return false;
    }

    return true;
  });

  return cleanedLines.join('\n');
}

export function createInlineCommentsPrompt(filesWithAiComments: string[]): string {
  const fileList = filesWithAiComments
    .sort((a, b) => a.localeCompare(b))
    .map((filePath) => `- ${filePath}`)
    .join('\n');
  const prompt = `${basePrPrompt}

### Review Format

The review comments are injected into the code files as special 'AI comments'. These comments are prefixed with 'AI:' and may be enclosed in markers like '// AI_COMMENT_START' and '// AI_COMMENT_END'. The code lines in between the start and end markers are the specific lines being commented on in the review, but you should analyze the entire file to see what other pieces of code may need to be updated in response.

After addressing a comment, remove the AI comment itself and its markers.

Files with AI Comments:
${fileList}
`;

  return prompt;
}
