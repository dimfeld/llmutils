import * as path from 'path';
import * as crypto from 'crypto';
import { findClosestMatches } from '../../editor/closest_match.ts';
import type { DetailedReviewComment } from '../types.ts';
import { basePrPrompt } from '../prompts.ts';
import { error } from '../../logging.ts';
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
 */
function findBestMatchLine(
  originalContent: string,
  diffForContext: DetailedReviewComment['diffForContext'],
  originalStartLine: number | null,
  originalLine: number
): { startLine: number; endLine: number } | null {
  const afterStateLines = getAfterStateLines(diffForContext);
  if (afterStateLines.length === 0) {
    // Fallback to original line numbers if no valid context
    return { startLine: originalStartLine ?? originalLine, endLine: originalLine };
  }

  const matches = findClosestMatches(originalContent, afterStateLines, {
    similarityThreshold: 0.8,
    maxMatches: 5,
  });

  if (matches.length === 0) {
    // No match found, return null
    return null;
  }

  // Convert matches to 1-indexed line numbers used by comments
  for (const match of matches) {
    match.startLine += 1;
    match.endLine += 1;
  }

  // Find the match closest to the original line numbers
  const originalReferenceLine = originalStartLine ?? originalLine;
  let bestMatch = matches[0];
  let minDistance = Math.abs(bestMatch.startLine - originalReferenceLine);

  for (const match of matches.slice(1)) {
    const distance = Math.abs(match.startLine - originalReferenceLine);
    // Prefer match with higher score, or if scores are equal, the one with smaller distance
    if (
      match.score > bestMatch.score ||
      (match.score === bestMatch.score && distance < minDistance)
    ) {
      bestMatch = match;
      minDistance = distance;
    }
  }

  // Adjust line numbers based on the comment's position within the diff context
  // Find the index of the target line in afterStateLines by matching newLineNumber
  let targetIndex = -1;
  for (let i = 0; i < diffForContext.length; i++) {
    if (diffForContext[i].newLineNumber === originalReferenceLine) {
      targetIndex = i;
      break;
    }
  }

  // If no exact match, fallback to using the original line numbers relative to the match
  if (targetIndex === -1) {
    error(`No matching newLineNumber found for line ${originalReferenceLine} in diffForContext`);
    return {
      startLine: bestMatch.startLine,
      endLine: bestMatch.endLine,
    };
  }

  // Calculate the offset from the start of the matched context
  const lineOffset = targetIndex;
  const adjustedStartLine = bestMatch.startLine + lineOffset;
  const adjustedEndLine =
    originalStartLine && originalStartLine !== originalLine
      ? adjustedStartLine + (originalLine - originalStartLine)
      : adjustedStartLine;

  return {
    startLine: adjustedStartLine,
    endLine: adjustedEndLine,
  };
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
  // If the file already has AI comments left over from a cancelled run, remove them
  originalContent = removeAiCommentMarkers(originalContent, filePath);

  const lines = originalContent.split('\n');
  const newLines: string[] = [];

  const insertBefore = new Map<number, string[]>();
  const insertAfter = new Map<number, string[]>();

  const errors: string[] = [];

  // The file may ave changed since it was reviewed, so process the comments to determine
  // adjusted line numbers.
  const commentsWithAdjustedLines = commentsForFile
    .map((comment) => {
      const bestMatchResult = findBestMatchLine(
        originalContent,
        comment.diffForContext,
        comment.thread.startLine,
        comment.thread.line
      );

      if (!bestMatchResult) {
        let lineRange = comment.thread.startLine
          ? `${comment.thread.startLine}-${comment.thread.line}`
          : comment.thread.line;
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
      const relevantLine1Based = comment.startLine;
      const relevantLine0Based = relevantLine1Based - 1;

      // If no </script> tag or comment is after it, use HTML style. Otherwise JS style.
      if (scriptEndTagIndex === -1 || relevantLine0Based >= scriptEndTagIndex) {
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
      const uniqueId = crypto.randomUUID().slice(0, 8);
      const startMarkerLine = currentPrefixer(`AI_COMMENT_START_${uniqueId}`);
      const endMarkerLine = currentPrefixer(`AI_COMMENT_END_${uniqueId}`);

      const insertionPointStart0Based = startLine - 1;
      addToMapList(insertBefore, insertionPointStart0Based, [
        startMarkerLine,
        ...aiPrefixedBodyLines,
      ]);

      const insertionPointEnd0Based = endLine - 1;
      addToMapList(insertAfter, insertionPointEnd0Based, [endMarkerLine]);
    } else {
      // Single-line comment: insert before the startLine
      const insertionPoint0Based = startLine - 1;
      addToMapList(insertBefore, insertionPoint0Based, aiPrefixedBodyLines);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (insertBefore.has(i)) {
      newLines.push(...insertBefore.get(i)!);
    }
    newLines.push(lines[i]);
    if (insertAfter.has(i)) {
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

  const candidates = [prefixer('AI_COMMENT_START_'), prefixer('AI_COMMENT_END_'), prefixer('AI:')];

  const cleanedLines = lines.filter((line, index) => {
    const trimmed = line.trim();

    // Handle Svelte: check if line is in script or template section
    let theseCandidates = candidates;
    const tryOtherPrefixer = isSvelte && (scriptEndTagIndex === -1 || index >= scriptEndTagIndex);
    if (tryOtherPrefixer) {
      let thisPrefixer = (text: string) => `<!-- ${text}`;
      theseCandidates = [
        thisPrefixer('AI_COMMENT_START_'),
        thisPrefixer('AI_COMMENT_END_'),
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

The review comments are injected into the code files as special 'AI comments'. These comments are prefixed with 'AI:' and may be enclosed in markers like '// AI_COMMENT_START_XYZ' and '// AI_COMMENT_END_XYZ'. The code lines in between the start and end markers are the specific lines being commented on in the review, but you should analyze the entire file to see what other pieces of code may need to be updated in response.

After addressing a comment, remove the AI comment itself and its markers.

Files with AI Comments:
${fileList}
`;

  return prompt;
}
