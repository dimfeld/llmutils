// parse raw edits without any format guidance
import { $ } from 'bun';
import * as path from 'path';

import { debugLog } from '../logging.ts';
import type { ProcessFileOptions } from '../apply-llm-edits.ts';

function processLastNonEmptyLine(line: string) {
  // Check for markdown header (e.g., **`filename`**)
  line = line.trim();
  const markdownMatch =
    line.match(/\*\*`?(\S+?)`?\*\*/) ||
    line.match(/^`(\S+?)`$/) ||
    line.match(/^#+ +`?([^`]+)`?$/) ||
    line.match(/#+ .+ `(\S+?)`/);
  if (markdownMatch && markdownMatch[1].includes('.')) {
    debugLog('Found markdown header:', markdownMatch[1]);

    return markdownMatch[1].trim();
  }
  // Check for raw filename (e.g., src/some/file.js)
  let plainPathFirstLine = /^(\S+\.\w{2,6})$/.exec(line.trim());
  if (plainPathFirstLine) {
    debugLog('Found raw filename:', line);
    return plainPathFirstLine[1];
  }
}

function findFilenameOnFirstLine(line: string) {
  let commentContentsMatch =
    /^\/\/ +(.+)/.exec(line) ||
    /^#+ +(.+)/.exec(line) ||
    /^\s*\/\* +(.+)\*\/.*/.exec(line) ||
    /^<!-- (.+?) -->/.exec(line) ||
    /^<file path="(.+?)">/.exec(line);

  if (commentContentsMatch) {
    let filename = commentContentsMatch[1].trim();
    if (filename.startsWith('file:')) {
      filename = filename.split(':')[1].trim();
    }
    return filename;
  }

  // Look for something that looks like a path with an extension
  let plainPathFirstLine = /^(\S+\.\w{2,6})$/.exec(line.trim());
  if (plainPathFirstLine) {
    return plainPathFirstLine[1];
  }
}

export async function processRawFiles({ content, writeRoot, dryRun }: ProcessFileOptions) {
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
  let expectedEndTag = '';
  const filesToWrite = new Map();

  // Process line by line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (state === 'searching') {
      if (line.startsWith('```')) {
        debugLog('Found start of code block');
        expectedEndTag = '```';
        state = 'startCodeBlock';
      } else if (line.startsWith('<file ')) {
        expectedEndTag = '</file>';

        let m = /^<file path="(.+?)">/.exec(line);
        if (m) {
          filename = m[1];
          // Skip the startCodeBlock state since we already have the filename
          state = 'trimmingLeadingLines';
        } else {
          state = 'startCodeBlock';
        }
      }
      continue;
    }

    if (line.startsWith(expectedEndTag)) {
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
      stripEndingFileTag = false;
      expectedEndTag = '';
      continue;
    }

    if (state === 'startCodeBlock') {
      // Check preBlockLines for filename
      const lastNonEmptyLine = lines.slice(0, i).findLast((l) => {
        l = l.trim();
        // Sometimes it outputs a
        // ```
        // filename
        // ```
        // so this is an easy way to skip back to the filename
        return l && !l.startsWith('```');
      });
      if (lastNonEmptyLine) {
        debugLog('Found last non-empty line:', lastNonEmptyLine);

        let foundFilename = processLastNonEmptyLine(lastNonEmptyLine);
        if (foundFilename) {
          filename = foundFilename;
          state = 'trimmingLeadingLines';
          // The filename was outside of the code block, so this line is content we want to push.
          if (line.trim()) {
            // instead we should have manual line advancement so we can push off handling this
            currentBlock.push(line);
          }
          continue;
        }
      }

      // Fallback to checking first line inside the code block
      const commentMatch = findFilenameOnFirstLine(line);
      if (commentMatch) {
        stripEndingFileTag = line.startsWith(`<file `);
        filename = commentMatch;
        state = 'trimmingPostCommentLines';
        continue;
      } else {
        state = 'ignoring';
      }
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
      if (!dryRun) {
        await Bun.write(fullPath, content.join('\n'));
      }
      console.log(`Wrote ${content.length} lines to file: ${filePath}`);
    } catch (err) {
      console.error(`Failed to write ${filePath}: ${err as Error}`);
    }
  }
}
