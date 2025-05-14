import * as path from 'path';
import * as crypto from 'crypto';
import type { DetailedReviewComment } from '../types.ts';
import { basePrPrompt } from '../prompts.ts';

export interface AiCommentInsertionResult {
  contentWithAiComments: string;
  // any other metadata if needed
}

function addToMapList(map: Map<number, string[]>, key: number, values: string[]) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key)!.push(...values);
}

type LinePrefixer = (text: string) => string;

function getLinePrefixerForFile(filePath: string, firstLineOfFile?: string): LinePrefixer {
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
      return (text: string) => `<!-- ${text} -->`;
    case '.css':
    case '.scss':
    case '.less':
    case '.styl': // Stylus
      return (text: string) => `/* ${text} */`;
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
  const lines = originalContent.split('\n');
  const newLines: string[] = [];

  const insertBefore = new Map<number, string[]>();
  const insertAfter = new Map<number, string[]>();

  // Sort comments to ensure a deterministic order if multiple comments affect the same line.
  // Sorting by startLine then line.
  const sortedComments = [...commentsForFile].sort((a, b) => {
    const startA = a.thread.startLine ?? a.thread.line;
    const startB = b.thread.startLine ?? b.thread.line;
    if (startA !== startB) {
      return startA - startB;
    }

    // If both start and end lines are the same, maintain original relative order or sort by ID for stability
    return a.comment.id.localeCompare(b.comment.id);
  });

  const defaultPrefixer = getLinePrefixerForFile(filePath, lines.length > 0 ? lines[0] : undefined);
  const svelteJsPrefixer = (text: string) => `// ${text}`;
  const svelteHtmlPrefixer = (text: string) => `<!-- ${text} -->`;

  const useScriptTag = path.extname(filePath).toLowerCase() === '.svelte';
  const scriptEndTagIndex = useScriptTag
    ? lines.findIndex((line) => line.includes('</script>'))
    : -1;

  for (const comment of sortedComments) {
    let currentPrefixer: LinePrefixer = defaultPrefixer;

    if (useScriptTag) {
      // For Svelte files we do a dumb check to see if we're in the script or the template.
      const relevantLine1Based = comment.thread.startLine ?? comment.thread.line;
      const relevantLine0Based = relevantLine1Based - 1;

      // If no </script> tag, or comment is after it, use HTML style. Otherwise JS style.
      if (scriptEndTagIndex === -1 || relevantLine0Based >= scriptEndTagIndex) {
        currentPrefixer = svelteHtmlPrefixer;
      } else {
        currentPrefixer = svelteJsPrefixer;
      }
    }

    const aiPrefixedBodyLines = comment.comment.body
      .split('\n')
      .map((line) => currentPrefixer(`AI: ${line}`));

    // A comment is considered a "block" comment needing markers if startLine is specified.
    const startLine = comment.thread.startLine ?? comment.thread.line;
    const endLine = comment.thread.line;
    const isBlockComment = comment.thread.startLine != null && startLine !== endLine;

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
      // Single-line comment (startLine is null).
      // Prefixed body goes directly above the originalLine.
      // originalLine is 1-based. Convert to 0-based for map key.
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

  return { contentWithAiComments: newLines.join('\n') };
}

export function removeAiCommentMarkers(fileContent: string): string {
  const lines = fileContent.split('\n');
  const cleanedLines = lines.filter((line) => {
    // Remove lines starting with "AI: " (and any leading whitespace before "AI:")
    if (line.trim().startsWith('AI: ')) {
      return false;
    }
    // Check for AI comment markers. Allow for potential leading/trailing whitespace on the line itself.
    if (/^<!-- AI_COMMENT_(START|END)_[0-9a-f]{8} -->$/.test(line.trim())) {
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
