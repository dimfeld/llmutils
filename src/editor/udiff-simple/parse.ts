import * as path from 'path';
import * as fs from 'fs';
import * as diff from 'diff';
import type { ProcessFileOptions } from '../types.ts';

// Custom Error for specific diff application failures
class UnifiedDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnifiedDiffError';
  }
}

class SearchTextNotUnique extends Error {
  constructor(message: string = 'Search text is not unique in the content.') {
    super(message);
    this.name = 'SearchTextNotUnique';
  }
}

interface EditHunk {
  filePath: string; // File path is always resolved and present after initial parsing
  hunk: string[]; // Lines of the hunk (e.g., ['--- a/file.txt', '+++ b/file.txt', '@@ ... @@', '-old', '+new'])
}

const noMatchErrorTemplate = `UnifiedDiffNoMatch: hunk failed to apply!

{path} does not contain lines that match the diff you provided!
Try again.
DO NOT skip blank lines, comments, docstrings, etc!
The diff needs to apply cleanly to the lines in {path}!

{path} does not contain these {num_lines} exact lines in a row:
\`\`\`
{original}\`\`\`
`;

const notUniqueErrorTemplate = `UnifiedDiffNotUnique: hunk failed to apply!

{path} contains multiple sets of lines that match the diff you provided!
Try again.
Use additional \` \` lines to provide context that uniquely indicates which code needs to be changed.
The diff needs to apply to a unique set of lines in {path}!

{path} contains multiple copies of these {num_lines} lines:
\`\`\`
{original}\`\`\`
`;

const otherHunksAppliedMessage =
  'Note: some hunks did apply successfully. See the updated source code shown above.\n\n';

/**
 * Splits a string into lines, preserving the newline characters at the end of each line.
 * Mimics Python's `str.splitlines(keepends=True)`.
 * Handles `\n` and `\r\n` line endings.
 */
function splitLinesWithEndings(content: string): string[] {
  if (!content) {
    return [];
  }
  // This regex matches any sequence of characters followed by a newline (CRLF or LF),
  // or the end of the string. The 'g' flag ensures all matches are found.
  const matches = content.match(/.*(?:\r\n|\n|$)/g);
  if (!matches) return [];
  // The regex leaves an empty string at the end if the content ends with a newline. Remove it.
  if (matches.length > 0 && matches[matches.length - 1] === '') {
    return matches.slice(0, -1);
  }
  return matches;
}

/**
 * Extracts the "before" and "after" text from a hunk.
 * @param hunk An array of strings representing the lines of a diff hunk.
 * @param lines If true, returns arrays of lines; otherwise, returns joined strings.
 * @returns A tuple containing the "before" and "after" content.
 */
function hunkToBeforeAfter(hunk: string[], lines: true): [string[], string[]];
function hunkToBeforeAfter(hunk: string[], lines?: false): [string, string];
function hunkToBeforeAfter(
  hunk: string[],
  lines: boolean = false
): [string | string[], string | string[]] {
  const before: string[] = [];
  const after: string[] = [];

  for (const line of hunk) {
    if (line.length === 0) {
      // Handle completely empty lines if they somehow occur
      before.push(line);
      after.push(line);
      continue;
    }

    const op = line[0];
    const lineContent = line.substring(1);

    switch (op) {
      case ' ':
        before.push(lineContent);
        after.push(lineContent);
        break;
      case '-':
        before.push(lineContent);
        break;
      case '+':
        after.push(lineContent);
        break;
      // Ignore other lines like @@, ---, +++
    }
  }

  if (lines) {
    return [before, after];
  }

  return [before.join(''), after.join('')];
}

/**
 * Cleans up lines that consist purely of whitespace by removing the whitespace
 * but keeping the newline character(s).
 */
function cleanupPureWhitespaceLines(lines: string[]): string[] {
  return lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed === '') {
      // Extract original newline character(s)
      const match = line.match(/(\r?\n)$/);
      return match ? match[0] : ''; // Keep only the newline if present
    }
    return line;
  });
}

/**
 * Normalizes a hunk by cleaning whitespace and regenerating the diff.
 * This helps handle minor whitespace inconsistencies.
 */
function normalizeHunk(hunk: string[]): string[] {
  const [beforeLines, afterLines] = hunkToBeforeAfter(hunk, true);

  const cleanedBefore = cleanupPureWhitespaceLines(beforeLines);
  const cleanedAfter = cleanupPureWhitespaceLines(afterLines);

  // Use diff library to create a new unified diff hunk
  // We need context N large enough to encompass the entire change.
  const contextSize = Math.max(cleanedBefore.length, cleanedAfter.length);
  const patch = diff.createPatch(
    'after', // newFileName (placeholder)
    cleanedBefore.join(''),
    cleanedAfter.join(''),
    '', // oldHeader
    '', // newHeader
    { context: contextSize }
  );

  // createPatch includes header lines (---, +++, @@). We only want the hunk content lines.
  const patchLines = splitLinesWithEndings(patch);

  // Find the start of the actual hunk lines (after @@)
  const hunkStartIndex = patchLines.findIndex((line) => line.startsWith('@@'));
  if (hunkStartIndex === -1) {
    return []; // No changes found, return empty hunk
  }

  // Return only the lines from @@ onwards
  // Note: The python version returns lines *without* the @@ line,
  // but the structure of diff.createPatch includes it, and subsequent
  // processing in python (hunk_to_before_after) ignores it.
  // Let's return the lines *after* @@ to match python's effective input to hunk_to_before_after.
  // Actually, let's test if keeping @@ is better for apply_hunk logic.
  // The python code *appends* "@@ @@" before processing, suggesting it expects it.
  // Let's return the lines *including* @@ for now.
  // Re-reading python: it slices `list(new_hunk)[3:]` which removes ---, +++, @@.
  // So we should return lines *after* @@.
  return patchLines.slice(hunkStartIndex + 1);
}

/**
 * Attempts to apply a hunk by directly searching for the "before" text
 * and replacing it with the "after" text. Handles minor whitespace variations.
 * Throws SearchTextNotUnique if the "before" text appears multiple times.
 */
function directlyApplyHunk(content: string, hunk: string[]): string | null {
  const [beforeText, afterText] = hunkToBeforeAfter(hunk);

  if (!beforeText.trim()) {
    // If 'before' is just whitespace, it's likely an insertion.
    // This function is for replacement/deletion based on context.
    // Insertion logic is handled elsewhere (e.g., in doReplace for new files/appending).
    // However, the python code *does* proceed if beforeText is not empty string.
    // Let's refine: if beforeText is empty or only whitespace, we can't reliably search/replace.
    return null;
  }

  const [beforeLines] = hunkToBeforeAfter(hunk, true);
  const beforeLineNonWhitespace = beforeLines.map((line) => line.trim()).join('');

  // Refuse to do a repeated search and replace on a tiny bit of non-whitespace context
  // Use a simple substring count for approximation.
  const occurrences = (content.match(new RegExp(escapeRegExp(beforeText), 'g')) || []).length;

  if (beforeLineNonWhitespace.length < 10 && occurrences > 1) {
    // The python code returns None here, indicating failure for this direct method.
    // It doesn't throw the NotUnique error yet.
    return null;
  }

  // Try perfect match first
  try {
    const result = searchAndReplace(content, beforeText, afterText);
    return result;
  } catch (e) {
    if (e instanceof SearchTextNotUnique) {
      // Propagate the specific error if it's unique issue
      throw e;
    }
    // Other errors during search/replace might occur, treat as no match for now.
    // Or maybe try flexible search? Python code uses flexi_just_search_and_replace
    // which seems to be just search_and_replace with all_preprocs.
    // Let's stick to the simpler perfect match logic from diff-editor/parse.ts first.
    // If perfect match fails (returns null or throws non-unique error), return null.
    return null;
  }
}

/**
 * Escapes special characters in a string for use in a regular expression.
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

/**
 * Performs a simple, exact string replacement.
 * Throws SearchTextNotUnique if `part` appears more than once in `whole`.
 * Returns null if `part` is not found.
 */
function searchAndReplace(whole: string, part: string, replace: string): string | null {
  const regex = new RegExp(escapeRegExp(part), 'g');
  const matches = [...whole.matchAll(regex)];

  if (matches.length === 0) {
    return null; // Not found
  }

  if (matches.length > 1) {
    throw new SearchTextNotUnique(`Search text occurs ${matches.length} times.`);
  }

  // Exactly one match found
  const index = matches[0].index;
  return whole.substring(0, index) + replace + whole.substring(index + part.length);
}

/**
 * Applies a hunk to the content, trying direct application first,
 * then falling back to applying partial hunks if necessary.
 */
function applyHunk(content: string, hunk: string[]): string | null {
  // 1. Try direct application
  try {
    const directResult = directlyApplyHunk(content, hunk);
    if (directResult !== null) {
      return directResult;
    }
  } catch (e) {
    // If direct application throws SearchTextNotUnique, propagate it
    if (e instanceof SearchTextNotUnique) {
      throw e;
    }
    // Other errors in directApply might happen, fall through to partial application
  }

  // TODO: Port make_new_lines_explicit if needed. Skipping for now as it seems complex.
  // hunk = make_new_lines_explicit(content, hunk)

  // 2. Try applying partial hunks (more flexible matching)
  // This logic splits the hunk based on context (` `) vs change (`+`/`-`) lines
  // and tries to apply the change sections using varying amounts of context.

  const sections: { type: 'context' | 'change'; lines: string[] }[] = [];
  let currentSectionLines: string[] = [];
  let currentType: 'context' | 'change' | null = null;

  for (const line of hunk) {
    const op = line.length > 0 ? line[0] : ' ';
    const type = op === '+' || op === '-' ? 'change' : 'context';

    if (currentType === null) {
      currentType = type;
    }

    if (type !== currentType) {
      sections.push({ type: currentType, lines: currentSectionLines });
      currentSectionLines = [line];
      currentType = type;
    } else {
      currentSectionLines.push(line);
    }
  }
  // Add the last section
  if (currentType !== null && currentSectionLines.length > 0) {
    sections.push({ type: currentType, lines: currentSectionLines });
  }

  let currentContent = content;
  let allApplied = true;

  // Iterate through change sections, applying them with surrounding context
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].type === 'change') {
      const precedingContext =
        i > 0 && sections[i - 1].type === 'context' ? sections[i - 1].lines : [];
      const changes = sections[i].lines;
      const followingContext =
        i + 1 < sections.length && sections[i + 1].type === 'context' ? sections[i + 1].lines : [];

      try {
        const partialResult = applyPartialHunk(
          currentContent,
          precedingContext,
          changes,
          followingContext
        );
        if (partialResult !== null) {
          currentContent = partialResult;
        } else {
          allApplied = false;
          break; // Stop if any partial hunk fails
        }
      } catch (e) {
        // If partial application throws SearchTextNotUnique, consider it a failure for this attempt
        if (e instanceof SearchTextNotUnique) {
          allApplied = false;
          // Re-throw the specific error? Or just mark as failed?
          // Python code seems to just break and return None overall if any part fails.
          // Let's re-throw to provide specific feedback if uniqueness is the issue.
          throw e;
        }
        // Other errors also mean failure
        allApplied = false;
        break;
      }
    }
  }

  return allApplied ? currentContent : null;
}

/**
 * Tries to apply a section of changes using varying amounts of preceding
 * and following context lines to find a unique match.
 */
function applyPartialHunk(
  content: string,
  precedingContext: string[],
  changes: string[],
  followingContext: string[]
): string | null {
  const lenPrec = precedingContext.length;
  const lenFoll = followingContext.length;
  const totalContext = lenPrec + lenFoll;

  // Iterate dropping context lines, from most context to least
  for (let drop = 0; drop <= totalContext; drop++) {
    const useContext = totalContext - drop;

    // Iterate through combinations of preceding/following context to use
    for (let usePrec = Math.min(lenPrec, useContext); usePrec >= 0; usePrec--) {
      const useFoll = useContext - usePrec;
      if (useFoll < 0 || useFoll > lenFoll) {
        continue;
      }

      const thisPrec = usePrec > 0 ? precedingContext.slice(lenPrec - usePrec) : [];
      const thisFoll = followingContext.slice(0, useFoll);

      const currentHunk = [...thisPrec, ...changes, ...thisFoll];

      // Try applying this specific combination of context + changes
      try {
        const result = directlyApplyHunk(content, currentHunk);
        if (result !== null) {
          return result; // Success!
        }
      } catch (e) {
        // If this specific context combination leads to non-unique match,
        // re-throw it, as more context might be needed (handled by outer loops).
        // Or maybe just continue trying other combinations? Python's behavior isn't explicit here.
        // Let's assume if directlyApplyHunk throws NotUnique, this partial attempt failed.
        if (e instanceof SearchTextNotUnique) {
          // Let outer loop try more/less context. If all fail, the final error will be raised.
          // However, if *any* partial hunk attempt throws NotUnique, the whole process should fail with NotUnique.
          // Let's re-throw immediately.
          throw e;
        }
        // Ignore other errors (like no match) and continue trying combinations.
      }
    }
  }

  return null; // No combination worked
}

/**
 * Applies the edits to the specified file content.
 * Handles creating new files.
 */
async function doReplace(
  fname: string,
  content: string | null, // null if file doesn't exist
  hunk: string[]
): Promise<string | null> {
  const [beforeText, afterText] = hunkToBeforeAfter(hunk);
  const absFname = path.resolve(fname); // Ensure absolute path

  // Handle creating a new file
  const fileExists = content !== null; // Assume null content means file doesn't exist
  if (!fileExists && !beforeText.trim()) {
    // If file doesn't exist and the 'before' part is empty/whitespace,
    // treat it as creating a new file with the 'after' content.
    return afterText; // Return the content for the new file
  }

  if (content === null) {
    // If file doesn't exist but 'before' is not empty, it's an error (cannot apply change to non-existent file)
    return null;
  }

  // Handle inserting into an empty file or appending?
  // Python code checks `if not before_text.strip(): new_content = content + after_text`
  // This seems to handle appending if the diff specifies adding lines without removing/changing existing ones.
  // Let's try applying this logic: If 'before' is effectively empty, just append 'after'.
  if (!beforeText.trim()) {
    // Append to existing file content
    return content + afterText;
  }

  // Apply the hunk using the main application logic
  // This might throw SearchTextNotUnique
  return applyHunk(content, hunk);
}

/**
 * Parses the LLM response content to find ```diff blocks and extract hunks, including nested diff blocks.
 */
export function findDiffs(content: string): { filePath: string | null; hunk: string[] }[] {
  content = content.trimStart();
  if (!content.endsWith('\n')) {
    content += '\n';
  }
  const lines = splitLinesWithEndings(content);
  const edits: { filePath: string | null; hunk: string[] }[] = [];

  // Stack to track nested fenced blocks
  let fenceStack: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trimEnd();

    // Detect start of a fenced block
    if (line.startsWith('```')) {
      const fenceType = line.substring(3).trim();
      if (fenceStack.length === 0 && fenceType === 'diff') {
        // Top-level diff block
        const result = processFencedBlock(lines, i + 1);
        edits.push(...result.edits);
        i = result.nextLineNum;
        continue;
      } else if (fenceType === 'diff') {
        // Nested diff block, collect it as a single hunk
        let nestedContent: string[] = [];
        let j = i;
        let nestedFenceCount = 1;

        while (j < lines.length && nestedFenceCount > 0) {
          const nextLine = lines[j];
          nestedContent.push(nextLine);
          if (nextLine.startsWith('```')) {
            if (nextLine.trim() === '```') {
              nestedFenceCount--;
            } else if (nextLine.startsWith('```diff')) {
              nestedFenceCount++;
            }
          }
          j++;
        }

        // Remove the closing fence from nestedContent
        if (nestedContent[nestedContent.length - 1].trim() === '```') {
          nestedContent.pop();
        }

        // Process the nested diff block
        const nestedEdits = findDiffs(nestedContent.join(''));
        edits.push(...nestedEdits);
        i = j;
        continue;
      } else {
        // Other fenced block (e.g., ```yaml), push to stack
        fenceStack.push(fenceType);
      }
    } else if (line.trim() === '```' && fenceStack.length > 0) {
      // End of a non-diff fenced block
      fenceStack.pop();
    } else if (fenceStack.length === 0 && line.startsWith('--- ')) {
      // Non-fenced diff at the start of content
      const result = processFencedBlock(lines, i);
      edits.push(...result.edits);
      if (result.edits.length) {
        return edits;
      }
    }

    i++;
  }

  return edits;
}

/**
 * Processes a fenced diff block to extract file paths and hunks.
 */
function processFencedBlock(
  lines: string[],
  startLineNum: number
): { edits: { filePath: string | null; hunk: string[] }[]; nextLineNum: number } {
  let lineNum = startLineNum;
  while (lineNum < lines.length && !lines[lineNum].startsWith('```')) {
    lineNum++;
  }
  const endLineNum = lineNum;

  const blockLines = lines.slice(startLineNum, endLineNum);
  // Add sentinel marker for easier parsing of the last hunk
  blockLines.push('@@ @@\n');

  const edits: { filePath: string | null; hunk: string[] }[] = [];
  let currentFilePath: string | null = null;
  let currentHunk: string[] = [];
  let inHunk = false; // Are we between @@ markers?
  let hasChanges = false; // Does the current hunk have +/- lines?

  // Check for --- / +++ lines at the beginning
  let blockStartIndex = 0;
  if (
    blockLines.length >= 2 &&
    blockLines[0].startsWith('--- ') &&
    blockLines[1].startsWith('+++ ')
  ) {
    const a_fname = blockLines[0].substring(4).trim();
    const b_fname = blockLines[1].substring(4).trim();

    // Standard git diff path stripping logic
    if ((a_fname.startsWith('a/') || a_fname === '/dev/null') && b_fname.startsWith('b/')) {
      currentFilePath = b_fname.substring(2);
    } else if (a_fname === '/dev/null') {
      currentFilePath = b_fname; // Creating new file
    } else {
      // Assume b_fname is the intended path if no standard prefixes
      currentFilePath = b_fname;
    }
    blockStartIndex = 2;
  }

  for (let i = blockStartIndex; i < blockLines.length; i++) {
    const line = blockLines[i];

    if (line.startsWith('@@')) {
      // End of previous hunk (if any)
      if (inHunk && hasChanges) {
        edits.push({ filePath: currentFilePath, hunk: currentHunk });
      }
      // Start of new hunk
      currentHunk = [];
      inHunk = true;
      hasChanges = false;
    } else if (
      line.startsWith('--- ') &&
      i + 1 < blockLines.length &&
      blockLines[i + 1].startsWith('+++ ')
    ) {
      // New hunk in the same fenced block
      // Finish previous hunk if any
      if (inHunk) {
        if (currentHunk.at(-1) === '\n') {
          currentHunk.pop();
        }
        edits.push({ filePath: currentFilePath, hunk: currentHunk });
      }

      const a_fname = line.substring(4).trim();
      const b_fname = blockLines[i + 1].substring(4).trim();
      if ((a_fname.startsWith('a/') || a_fname === '/dev/null') && b_fname.startsWith('b/')) {
        currentFilePath = b_fname.substring(2);
      } else if (a_fname === '/dev/null') {
        currentFilePath = b_fname;
      } else {
        currentFilePath = b_fname;
      }
      i++; // Skip the +++ line

      currentHunk = [];
      hasChanges = false;
    } else if (inHunk) {
      // Inside a hunk, collect the line
      currentHunk.push(line);
      const op = line.length > 0 ? line[0] : ' ';
      if (op === '+' || op === '-') {
        hasChanges = true;
      }
    }
    // Ignore lines outside hunks that aren't ---/+++ pairs
  }

  if (inHunk) {
    if (currentHunk.at(-1) === '\n') {
      currentHunk.pop();
    }

    if (currentHunk.length) {
      edits.push({ filePath: currentFilePath, hunk: currentHunk });
    }
  }

  return { edits, nextLineNum: endLineNum + 1 };
}

// Main processing function
export async function processUnifiedDiff({
  content,
  writeRoot,
  dryRun,
}: ProcessFileOptions): Promise<void> {
  const rawEdits = findDiffs(content);

  const edits: EditHunk[] = [];
  let lastPath: string | null = null;
  for (const { filePath, hunk } of rawEdits) {
    let resolvedPath = filePath;
    if (resolvedPath) {
      lastPath = resolvedPath;
    } else {
      resolvedPath = lastPath;
    }

    if (!resolvedPath) {
      console.warn('Skipping hunk with no associated file path:', hunk.join(''));
      continue;
    }
    // Normalize path separators for consistency
    resolvedPath = resolvedPath.replace(/\\/g, '/');
    edits.push({ filePath: resolvedPath, hunk });
  }

  await applyEdits(edits, writeRoot, dryRun);
}

async function applyEdits(
  edits: EditHunk[],
  rootDir: string,
  dryRun: boolean = false
): Promise<void> {
  const errors: string[] = [];
  const appliedHunks: Set<string> = new Set();
  const uniqueEdits: EditHunk[] = [];

  // Deduplicate hunks based on path + content
  for (const edit of edits) {
    const normalizedHunk = normalizeHunk(edit.hunk);
    if (normalizedHunk.length === 0) {
      continue; // Skip empty hunks after normalization
    }

    const hunkKey = `${edit.filePath}\n${normalizedHunk.join('')}`;
    if (appliedHunks.has(hunkKey)) {
      continue;
    }
    appliedHunks.add(hunkKey);
    uniqueEdits.push({ filePath: edit.filePath, hunk: normalizedHunk });
  }

  let hunksAppliedCount = 0;
  for (const { filePath, hunk } of uniqueEdits) {
    const fullPath = path.resolve(rootDir, filePath);
    let currentContent: string | null = null;
    let fileExists = false;

    try {
      currentContent = await Bun.file(fullPath).text();
      fileExists = true;
    } catch (e) {
      // file doesn't exist
    }

    try {
      const newContent = await doReplace(fullPath, currentContent, hunk);

      if (newContent !== null) {
        // SUCCESS!
        console.log(`Applying hunk to ${filePath}`);
        if (!dryRun) {
          await Bun.write(fullPath, newContent);
        }
        hunksAppliedCount++;
      } else {
        // FAILURE: No match
        const [originalText] = hunkToBeforeAfter(hunk);
        const numLines = splitLinesWithEndings(originalText).length;
        errors.push(
          noMatchErrorTemplate
            .replace(/{path}/g, filePath)
            .replace(/{num_lines}/g, String(numLines))
            .replace(/{original}/g, originalText)
        );
      }
    } catch (e) {
      if (e instanceof SearchTextNotUnique) {
        // FAILURE: Not unique
        const [originalText] = hunkToBeforeAfter(hunk);
        const numLines = splitLinesWithEndings(originalText).length;
        errors.push(
          notUniqueErrorTemplate
            .replace(/{path}/g, filePath)
            .replace(/{num_lines}/g, String(numLines))
            .replace(/{original}/g, originalText)
        );
      } else {
        // Unexpected error during application
        console.error(`Unexpected error applying hunk to ${filePath}:`, e);
        errors.push(
          `Unexpected error applying hunk to ${filePath}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }

  if (errors.length > 0) {
    let errorMessage = errors.join('\n\n');
    if (hunksAppliedCount > 0 && hunksAppliedCount < uniqueEdits.length) {
      errorMessage += '\n\n' + otherHunksAppliedMessage;
    }
    throw new UnifiedDiffError(errorMessage);
  }

  if (hunksAppliedCount === 0 && uniqueEdits.length > 0) {
    // If there were hunks but none applied and no specific errors were caught, throw a generic failure.
    // This might happen if all hunks resulted in `doReplace` returning null without throwing.
    throw new UnifiedDiffError(
      'Failed to apply any of the provided diff hunks. Check the diff format and context.'
    );
  }

  console.log(`Successfully applied ${hunksAppliedCount} hunks.`);
}
