import { debugLog, error, log } from '../../logging.ts';
import type { ProcessFileOptions } from '../types.ts';
import { secureWrite } from '../../common/fs.ts'; // Import secureWrite

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

export async function processRawFiles({
  content,
  writeRoot,
  dryRun,
  suppressLogging = false,
  ignoreFiles,
}: ProcessFileOptions) {
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
  const filesToWrite = new Map<string, string[]>();

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
    filesToWrite.set(filename, currentBlock);
  }

  // Write files to disk
  for (const [filePath, contentLines] of filesToWrite) {
    if (ignoreFiles?.includes(filePath)) {
      continue;
    }

    try {
      if (!dryRun) {
        let contentStr = contentLines.join('\n').trimEnd();
        // Sometimes the model sticks a </file> on the end of the file.
        if (contentStr.endsWith('</file>')) {
          contentStr = contentStr.slice(0, -'</file>'.length);
        }
        if (!(await Bun.file(filePath).exists()) && filePath.includes(' ')) {
          if (!suppressLogging)
            log(`Skipping nonexistent file that looks more like a comment: ${filePath}`);
          continue;
        }
        await secureWrite(writeRoot, filePath, contentStr + '\n');
      }
      if (!suppressLogging) log(`Wrote ${contentLines.length} lines to file: ${filePath}`);
    } catch (err) {
      error(`Failed to write ${filePath}: ${err as Error}`);
    }
  }
}
