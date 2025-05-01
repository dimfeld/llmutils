import * as path from 'path';
import * as diff from 'diff';
import type {
  ProcessFileOptions,
  EditResult,
  SuccessResult,
  NoMatchFailure,
  NotUniqueFailure,
  MatchLocation,
  ClosestMatchResult,
} from '../types.ts';
import { findClosestMatches } from '../closest_match.ts';
import { secureWrite } from '../../rmfilter/utils.js';
import { error, log, warn } from '../../logging.ts';

class SearchTextNotUnique extends Error {
  constructor(message: string = 'Search text is not unique in the content.') {
    super(message);
    this.name = 'SearchTextNotUnique';
  }
}

interface EditHunk {
  filePath: string;
  hunk: string[];
}

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
      return match ? match[0] : '';
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
  const patch = diff.createPatch('after', cleanedBefore.join(''), cleanedAfter.join(''), '', '', {
    context: contextSize,
  });

  // createPatch includes header lines (---, +++, @@). We only want the hunk content lines.
  const patchLines = splitLinesWithEndings(patch);

  // Find the start of the actual hunk lines (after @@)
  const hunkStartIndex = patchLines.findIndex((line) => line.startsWith('@@'));
  if (hunkStartIndex === -1) {
    return [];
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
function directlyApplyHunk(content: string, hunk: string[], log = false): string | null {
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
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    return null;
  }

  if (matches.length > 1) {
    throw new SearchTextNotUnique(`Search text occurs ${matches.length} times.`);
  }

  // Exactly one match found
  const index = matches[0].index;
  return whole.substring(0, index) + replace + whole.substring(index + part.length);
}

/**
 * Finds all occurrences of a substring and returns their locations.
 */
function findAllMatches(whole: string, part: string): MatchLocation[] {
  const locations: MatchLocation[] = [];
  if (!part || !whole) {
    return locations;
  }

  const regex = new RegExp(escapeRegExp(part), 'g');
  const fileLines = splitLinesWithEndings(whole);

  for (const match of whole.matchAll(regex)) {
    const startIndex = match.index!;
    const beforeMatch = whole.substring(0, startIndex);
    // Count occurrences of '\n' to determine the line number (1-based)
    const startLine = (beforeMatch.match(/\n/g) || []).length + 1;

    // Determine the lines covered by `part`
    const partLines = splitLinesWithEndings(part);
    const numPartLines = partLines.length;

    // Extract the corresponding lines from the pre-split `whole` lines array
    const endLineIndex = Math.min(startLine + numPartLines - 1, fileLines.length);
    const contextLines = fileLines.slice(startLine - 1, endLineIndex);

    locations.push({ startIndex, startLine, contextLines });
  }

  return locations;
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
          break;
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

function changeLineToContext(line: string): string {
  return line[0] === '+' || line[0] === '-' ? ' ' + line.slice(1) : line;
}

function tryConvertedContextHunk(
  content: string,
  precedingContext: string[],
  changes: string[],
  followingContext: string[],
  convertPreceding: number,
  convertFollowing: number
): string | null {
  if (convertPreceding + convertFollowing >= changes.length) {
    return null;
  }

  const switched = [
    ...precedingContext,
    ...changes.slice(0, convertPreceding).map(changeLineToContext),
    ...(convertFollowing
      ? changes.slice(convertPreceding, -convertFollowing)
      : changes.slice(convertPreceding)),
    ...(convertFollowing ? changes.slice(-convertFollowing).map(changeLineToContext) : []),
    ...followingContext,
  ];

  return directlyApplyHunk(content, switched);
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

  const convertTable = [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 1],
    [0, 2],
    [1, 1],
    [2, 1],
    [1, 2],
    [2, 2],
  ];

  for (const [convertPreceding, convertFollowing] of convertTable) {
    const result = tryConvertedContextHunk(
      content,
      precedingContext,
      changes,
      followingContext,
      convertPreceding,
      convertFollowing
    );
    if (result !== null) {
      return result;
    }
  }

  // Iterate dropping context lines, from most context to least
  for (let drop = 0; drop <= totalContext; drop++) {
    const useContext = totalContext - drop;

    // Iterate through combinations of preceding/following context to use
    for (let usePrec = Math.min(lenPrec, useContext); usePrec >= 0; usePrec--) {
      if (usePrec > useContext) {
        continue;
      }

      const useFoll = useContext - usePrec;
      if (useFoll < 0 || useFoll > lenFoll) {
        continue;
      }

      const thisPrec = usePrec > 0 ? precedingContext.slice(-usePrec) : [];
      const thisFoll = followingContext.slice(0, useFoll);

      const currentHunk = [...thisPrec, ...changes, ...thisFoll];

      // Try applying this specific combination of context + changes
      try {
        const result = directlyApplyHunk(content, currentHunk);
        if (result !== null) {
          return result;
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

  return null;
}

/**
 * Applies the edits to the specified file content.
 * Handles creating new files.
 */
export function doReplace(content: string | null, hunk: string[]): string | null {
  const [beforeText, afterText] = hunkToBeforeAfter(hunk);

  // Handle creating a new file
  const fileExists = content !== null;
  if (!fileExists && !beforeText.trim()) {
    // If file doesn't exist and the 'before' part is empty/whitespace,
    // treat it as creating a new file with the 'after' content.
    return afterText;
  }

  if (content === null) {
    // If file doesn't exist but 'before' is not empty, it's an error (cannot apply change to non-existent file)
    return null;
  }
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
  let inHunk = false;
  let hasChanges = false;

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
      currentFilePath = b_fname;
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
      i++;

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
}: ProcessFileOptions): Promise<EditResult[]> {
  const rawEdits = findDiffs(content);

  const edits: EditHunk[] = [];
  let lastPath: string | null = null;
  for (const { filePath, hunk } of rawEdits) {
    let resolvedPath = filePath;
    if (resolvedPath === '/dev/null') {
      continue;
    }
    if (resolvedPath) {
      lastPath = resolvedPath;
    } else {
      resolvedPath = lastPath;
    }

    if (!resolvedPath) {
      warn('Skipping hunk with no associated file path:', hunk.join(''));
      continue;
    }
    // Normalize path separators for consistency
    resolvedPath = resolvedPath.replace(/\\/g, '/');
    edits.push({ filePath: resolvedPath, hunk });
  }

  const results = await applyEdits(edits, writeRoot, dryRun);

  // Log summary based on results
  const successCount = results.filter((r) => r.type === 'success').length;
  const noMatchCount = results.filter((r) => r.type === 'noMatch').length;
  const notUniqueCount = results.filter((r) => r.type === 'notUnique').length;
  log(
    `Processing complete. Success: ${successCount}, No Match: ${noMatchCount}, Not Unique: ${notUniqueCount}`
  );

  return results;
}

async function applyEdits(
  edits: EditHunk[],
  rootDir: string,
  dryRun: boolean = false
): Promise<EditResult[]> {
  const results: EditResult[] = [];
  const appliedHunks: Set<string> = new Set();
  const uniqueEdits: EditHunk[] = [];

  // Deduplicate hunks based on path + content
  for (const edit of edits) {
    const normalizedHunk = normalizeHunk(edit.hunk);
    if (normalizedHunk.length === 0) {
      continue;
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
    const fullPathForRead = path.resolve(rootDir, filePath);
    let currentContent: string | null = null;

    try {
      const file = Bun.file(fullPathForRead);
      if (await file.exists()) {
        currentContent = await file.text();
      } else if (filePath.includes(' ')) {
        log(`Skipping nonexistent file that looks more like a comment: ${filePath}`);
        continue;
      }
    } catch (e) {
      error(`Error accessing file ${filePath}: ${e as Error}`);
      // TODO: How to report file access errors? Add a new EditResult type?
      // For now, log and skip, not adding to results.
      // Or maybe create a generic failure? Let's skip for now.
      continue;
    }

    try {
      const newContent = doReplace(currentContent, hunk);

      if (newContent !== null) {
        // SUCCESS!
        const [originalText, updatedText] = hunkToBeforeAfter(hunk);
        results.push({
          type: 'success',
          filePath,
          originalText,
          updatedText,
        });
        log(`Applying hunk to ${filePath}`);
        if (!dryRun) {
          await secureWrite(rootDir, filePath, newContent);
        }
        hunksAppliedCount++;
      } else {
        // FAILURE: No match (doReplace returned null without throwing)
        const [originalText, updatedText] = hunkToBeforeAfter(hunk);
        let closestMatch: ClosestMatchResult | null = null;
        if (currentContent) {
          const searchLines = splitLinesWithEndings(originalText);
          const closestMatches = findClosestMatches(currentContent, searchLines, { maxMatches: 1 });
          closestMatch = closestMatches.length > 0 ? closestMatches[0] : null;
        }
        results.push({
          type: 'noMatch',
          filePath,
          originalText,
          updatedText,
          closestMatch,
        });
      }
    } catch (e) {
      if (e instanceof SearchTextNotUnique) {
        // FAILURE: Not unique (thrown by doReplace or its callees)
        const [originalText, updatedText] = hunkToBeforeAfter(hunk);
        let matchLocations: MatchLocation[] = [];
        if (currentContent) {
          matchLocations = findAllMatches(currentContent, originalText);
        }
        results.push({
          type: 'notUnique',
          filePath,
          originalText,
          updatedText,
          matchLocations,
        });
      } else {
        // Unexpected error during application
        error(`Unexpected error applying hunk to ${filePath}:`, e);
        // TODO: Decide how to report this. For now, log and skip adding a result.
      }
    }
  }

  // Log summary (optional, could be done by caller using returned results)
  // log(`Applied ${hunksAppliedCount} hunks successfully.`);

  return results;
}
