// parse raw edits without any format guidance
import { $ } from 'bun';
import * as path from 'path';

import { debugLog } from './logging.ts';

export interface ProcessFileOptions {
  content: string;
  writeRoot: string;
}

function processLastNonEmptyLine(line: string) {
  // Check for markdown header (e.g., **`filename`**)
  const markdownMatch = line.match(/\*\*`(.+?)`\*\*/) || line.match(/^`(.+?)`$/);
  if (markdownMatch) {
    debugLog('Found markdown header:', markdownMatch[1]);
    return markdownMatch[1].trim();
  }
  // Check for raw filename (e.g., src/some/file.js)
  else if (line.trim().includes('/')) {
    debugLog('Found raw filename:', line);
    return line.trim();
  }
}

function processFirstCommentLine(line: string) {
  let commentContentsMatch =
    /^\/\/ +(.+)/.exec(line) ||
    /^# +(.+)/.exec(line) ||
    /^\s*\/\* +(.+)\*\/.*/.exec(line) ||
    /^<!-- (.+?) -->/.exec(line) ||
    /^<file path="(.+?)">/.exec(line);

  if (!commentContentsMatch) {
    return;
  }
  let filename = commentContentsMatch[1].trim();
  if (filename.startsWith('file:')) {
    filename = filename.split(':')[1].trim();
  }
  return filename;
}
export async function processRawFiles({ content, writeRoot }: ProcessFileOptions) {
  // Split content into lines
  const lines = content.split('\n');
  let state:
    | 'searching'
    | 'startCodeBlock'
    | 'skippingLanguageSpecifier'
    | 'trimmingLeadingLines'
    | 'trimmingPostCommentLines'
    | 'ignoring'
    | 'copying' = 'searching';
  let currentBlock = [];
  let filename = null;
  let stripEndingFileTag = false;
  const filesToWrite = new Map();
  let preBlockLines = [];

  // Process line by line
  for (const line of lines) {
    if (state === 'searching' && !line.startsWith('```')) {
      preBlockLines.push(line);
      continue;
    }

    if (line.startsWith('```')) {
      if (state === 'searching') {
        debugLog('Found start of code block');
        state = 'startCodeBlock';
      } else {
        debugLog('Found end of code block filename=', filename);
        // Process completed block
        if (filename && state !== 'ignoring') {
          if (stripEndingFileTag && currentBlock[currentBlock.length - 1].trim() === '</file>') {
            currentBlock.pop();
          }
          filesToWrite.set(filename, currentBlock);
        }
        state = 'searching';
        currentBlock = [];
        filename = null;
        preBlockLines = []; // Reset for the next code block
        stripEndingFileTag = false;
      }
      continue;
    }

    if (state === 'startCodeBlock') {
      // Check preBlockLines for filename
      const lastNonEmptyLine = preBlockLines.findLast((l) => l.trim() !== '');
      if (lastNonEmptyLine) {
        debugLog('Found last non-empty line:', lastNonEmptyLine);

        let foundFilename = processLastNonEmptyLine(lastNonEmptyLine);
        if (foundFilename) {
          filename = foundFilename;
          state = 'skippingLanguageSpecifier';
          continue;
        }
      }

      // Fallback to checking first line inside the code block
      const commentMatch = processFirstCommentLine(line);
      if (commentMatch) {
        stripEndingFileTag = line.startsWith(`<file `);
        filename = commentMatch;
        state = 'trimmingPostCommentLines';
        continue;
      } else {
        state = 'ignoring';
      }
    }

    if (state === 'skippingLanguageSpecifier') {
      state = 'trimmingLeadingLines';
      continue; // Skip the language specifier line
    }

    if (state === 'trimmingLeadingLines' || state === 'trimmingPostCommentLines') {
      if (line.trim() === '') {
        continue; // Skip empty lines
      } else {
        state = 'copying';
      }
    }

    if (state === 'copying') {
      currentBlock.push(line);
    }
  }

  // Handle any remaining block
  debugLog(`Finished block: file '${filename}', ${currentBlock.length} lines`);
  if (filename && state !== 'ignoring' && currentBlock.length > 0) {
    if (stripEndingFileTag && currentBlock[currentBlock.length - 1].trim() === '</file>') {
      currentBlock.pop();
    }

    filesToWrite.set(filename, currentBlock);
  }

  // Write files to disk
  for (const [filePath, content] of filesToWrite) {
    const fullPath = path.resolve(writeRoot, filePath);
    try {
      await Bun.write(fullPath, content.join('\n'));
      console.log(`Wrote ${content.length} lines to file: ${filePath}`);
    } catch (err) {
      console.error(`Failed to write ${filePath}: ${err as Error}`);
    }
  }
}
