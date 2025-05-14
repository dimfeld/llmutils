import * as path from 'path';
import type { DetailedReviewComment } from '../types.ts';

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

export function createAiCommentsPrompt(
  filesWithAiComments: Map<string, string>,
  fileDiffs: Map<string, string>
): string {
  const promptParts: string[] = [];

  promptParts.push(
    `You will be provided with source code files that include special 'AI comments'. These comments are prefixed with 'AI:' and may be enclosed in markers like '<!-- AI_COMMENT_START_XYZ -->' and '<!-- AI_COMMENT_END_XYZ -->'. Your task is to address the instructions in these AI comments by modifying the code.`
  );
  promptParts.push(`- Make the necessary code changes to satisfy the AI comment.`);
  promptParts.push(
    `- After addressing a comment, **remove the AI comment itself and its markers**. Do not add any new comments like 'addressed' or 'fixed'. Simply make the change.`
  );
  promptParts.push(`- The diff from the parent branch is provided for context on recent changes.`);
  promptParts.push('');

  promptParts.push('Files with AI Comments:');
  for (const [filePath, content] of filesWithAiComments) {
    promptParts.push('---');
    promptParts.push(`Path: ${filePath}`);
    const lang = path.extname(filePath).slice(1).toLowerCase() || 'text';
    promptParts.push(`\`\`\`${lang}`);
    promptParts.push(content);
    promptParts.push('```');
  }
  promptParts.push('---');
  promptParts.push('');

  promptParts.push('Diffs from parent branch:');
  for (const [filePath, diff] of fileDiffs) {
    if (diff.trim() === '') continue;
    promptParts.push('---');
    promptParts.push(`Path: ${filePath}`);
    promptParts.push('```diff');
    promptParts.push(diff);
    promptParts.push('```');
  }
  promptParts.push('---');

  return promptParts.join('\n');
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
  // Sorting by originalStartLine then originalLine. If originalStartLine is null, use originalLine.
  const sortedComments = [...commentsForFile].sort((a, b) => {
    const startA = a.thread.originalStartLine ?? a.thread.originalLine;
    const startB = b.thread.originalStartLine ?? b.thread.originalLine;
    if (startA !== startB) {
      return startA - startB;
    }
    // If start lines are the same, sort by end line
    if (a.thread.originalLine !== b.thread.originalLine) {
      return a.thread.originalLine - b.thread.originalLine;
    }
    // If both start and end lines are the same, maintain original relative order or sort by ID for stability
    return a.comment.id.localeCompare(b.comment.id);
  });

  const defaultPrefixer = getLinePrefixerForFile(filePath, lines.length > 0 ? lines[0] : undefined);
  const svelteJsPrefixer = (text: string) => `// ${text}`;
  const svelteHtmlPrefixer = (text: string) => `<!-- ${text} -->`;

  for (const comment of sortedComments) {
    let currentPrefixer: LinePrefixer = defaultPrefixer;

    if (path.extname(filePath).toLowerCase() === '.svelte') {
      const scriptEndTagIndex = originalContent.lastIndexOf('</script>');
      const relevantLine1Based = comment.thread.originalStartLine ?? comment.thread.originalLine;
      const relevantLine0Based = relevantLine1Based - 1;

      let commentActualStartCharOffset = 0;
      if (relevantLine0Based >= 0) {
        let currentLineIdx = 0;
        let charIdx = 0;
        while (charIdx < originalContent.length) {
          if (currentLineIdx === relevantLine0Based) {
            commentActualStartCharOffset = charIdx;
            break;
          }
          if (originalContent[charIdx] === '\n') {
            currentLineIdx++;
          }
          charIdx++;
          // If loop is about to end and we haven't found the line, it means the line is effectively at EOF
          if (charIdx === originalContent.length && currentLineIdx < relevantLine0Based) {
            commentActualStartCharOffset = originalContent.length;
            break;
          }
        }
        // If relevantLine0Based is 0, commentActualStartCharOffset remains 0 if loop doesn't run (empty content) or breaks immediately.
        if (relevantLine0Based === 0 && originalContent.length === 0)
          commentActualStartCharOffset = 0;
        else if (relevantLine0Based === 0 && originalContent.length > 0)
          commentActualStartCharOffset = 0; // Start of first line
      }

      // If no </script> tag, or comment is after it, use HTML style. Otherwise JS style.
      if (scriptEndTagIndex === -1 || commentActualStartCharOffset >= scriptEndTagIndex) {
        currentPrefixer = svelteHtmlPrefixer;
      } else {
        currentPrefixer = svelteJsPrefixer;
      }
    }

    const aiPrefixedBodyLines = comment.comment.body
      .split('\n')
      .map((line) => currentPrefixer(`AI: ${line}`));

    // A comment is considered a "block" comment needing markers if originalStartLine is specified.
    const isBlockComment = comment.thread.originalStartLine !== null;

    if (isBlockComment) {
      const uniqueId = crypto.randomUUID().slice(0, 8);
      const startMarkerLine = currentPrefixer(`AI_COMMENT_START_${uniqueId}`);
      const endMarkerLine = currentPrefixer(`AI_COMMENT_END_${uniqueId}`);

      const insertionPointStart0Based = comment.thread.originalStartLine! - 1;
      addToMapList(insertBefore, insertionPointStart0Based, [
        startMarkerLine,
        ...aiPrefixedBodyLines,
      ]);

      const insertionPointEnd0Based = comment.thread.originalLine - 1;
      addToMapList(insertAfter, insertionPointEnd0Based, [endMarkerLine]);
    } else {
      // Single-line comment (originalStartLine is null).
      // Prefixed body goes directly above the originalLine.
      // originalLine is 1-based. Convert to 0-based for map key.
      const insertionPoint0Based = comment.thread.originalLine - 1;
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
