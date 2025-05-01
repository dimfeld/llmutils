// This is a port of Aider's edit_block coder
import * as path from 'path';
import * as fs from 'fs';
import * as diff from 'diff';
import stringComparison from 'string-comparison';
import type { ProcessFileOptions, EditResult, SuccessResult, NoMatchFailure } from '../types.ts';
import { secureWrite } from '../../rmfilter/utils.js';
import { findClosestMatches } from '../closest_match.ts';
import { error, log } from '../../logging.ts';

interface Edit {
  filePath: string;
  original: string;
  updated: string;
}

const fence = '```';

export async function processSearchReplace({ content, writeRoot, dryRun }: ProcessFileOptions) {
  const edits = getEdits(content, writeRoot);
  return await applyEdits(edits, writeRoot, dryRun);
}

function getEdits(content: string, rootDir: string): Edit[] {
  const edits = findOriginalUpdateBlocks(content, []);

  return edits
    .filter((edit) => edit.filePath !== null)
    .map((edit) => ({
      filePath: edit.filePath!,
      original: edit.original!,
      updated: edit.updated,
    }));
}

async function applyEdits(
  edits: Edit[],
  rootDir: string,
  dryRun: boolean = false
): Promise<EditResult[]> {
  const results: EditResult[] = [];

  for (const { filePath, original, updated } of edits) {
    if (filePath.includes('mathweb/flask')) {
      throw new Error(
        'Found edits from the sample prompt. Perhaps you forgot to copy the results?'
      );
    }

    const file = Bun.file(path.resolve(rootDir, filePath));
    let fileContent: string | null = null;
    if (await file.exists()) {
      fileContent = await file.text();
    } else if (filePath.includes(' ')) {
      log(`Skipping nonexistent file that looks more like a comment: ${filePath}`);
      continue;
    }
    const newContent = await doReplace(filePath, fileContent, original, updated);

    if (newContent !== null) {
      log(`Applying edit to ${filePath}`);
      if (!dryRun) {
        await secureWrite(rootDir, filePath, newContent);
      }
      const success: SuccessResult = {
        type: 'success',
        filePath,
        originalText: original,
        updatedText: updated,
      };
      results.push(success);
    } else {
      // Failure case: No exact match found by doReplace
      const closestMatches = fileContent
        ? findClosestMatches(fileContent, prep(original).lines, { maxMatches: 1 })
        : [];
      const failure: NoMatchFailure = {
        type: 'noMatch',
        filePath,
        originalText: original,
        updatedText: updated,
        closestMatch: closestMatches.length > 0 ? closestMatches[0] : null,
      };
      results.push(failure);
    }
  }

  return results;
}

async function doReplace(
  relativePath: string,
  content: string | null,
  beforeText: string,
  afterText: string
): Promise<string | null> {
  beforeText = stripQuotedWrapping(beforeText, relativePath);
  afterText = stripQuotedWrapping(afterText, relativePath);

  // File existence is determined by `content !== null`
  const fileExists = content !== null;

  if (!fileExists && !beforeText.trim()) {
    return afterText;
  }

  if (content === null) {
    return null;
  }

  if (!beforeText.trim()) {
    return content + afterText;
  }

  return replaceMostSimilarChunk(content, beforeText, afterText);
}

function stripQuotedWrapping(res: string, fname?: string): string {
  if (!res) return res;

  let lines = res.split('\n');

  if (fname && lines[0].trim().endsWith(path.basename(fname))) {
    lines = lines.slice(1);
  }

  if (lines[0].startsWith(fence) && lines[lines.length - 1].startsWith(fence)) {
    lines = lines.slice(1, -1);
  }

  let result = lines.join('\n');
  if (result && !result.endsWith('\n')) {
    result += '\n';
  }

  return result;
}

function replaceMostSimilarChunk(whole: string, part: string, replace: string): string | null {
  const { content: wholePrep, lines: wholeLines } = prep(whole);
  const { content: partPrep, lines: partLines } = prep(part);
  const { content: replacePrep, lines: replaceLines } = prep(replace);

  let res = perfectOrWhitespace(wholeLines, partLines, replaceLines);
  if (res) return res;

  // Handle spurious blank lines
  if (partLines.length > 2 && !partLines[0].trim()) {
    const skipBlankLinePartLines = partLines.slice(1);
    res = perfectOrWhitespace(wholeLines, skipBlankLinePartLines, replaceLines);
    if (res) return res;
  }

  return tryDotdotdots(wholePrep, partPrep, replacePrep);
}

function splitLinesWithEndings(content: string) {
  let lines = content.split('\n').map((line) => line + '\n');
  if (lines.length > 1 && lines.at(-1) === '\n') {
    lines = lines.slice(0, -1);
  }

  return lines;
}

function prep(content: string): { content: string; lines: string[] } {
  const lines = splitLinesWithEndings(content);
  if (content && !content.endsWith('\n')) {
    content += '\n';
  }
  return { content, lines };
}

function perfectOrWhitespace(
  wholeLines: string[],
  partLines: string[],
  replaceLines: string[]
): string | null {
  let res = perfectReplace(wholeLines, partLines, replaceLines);
  if (res) return res;

  res = replacePartWithMissingLeadingWhitespace(wholeLines, partLines, replaceLines);
  if (res) return res;

  res = replacePartWithExtraTrailingNewlines(wholeLines, partLines, replaceLines);
  if (res) return res;

  return null;
}

function perfectReplace(
  wholeLines: string[],
  partLines: string[],
  replaceLines: string[]
): string | null {
  const partLen = partLines.length;

  for (let i = 0; i <= wholeLines.length - partLen; i++) {
    const wholeSlice = wholeLines.slice(i, i + partLen);
    if (JSON.stringify(wholeSlice) === JSON.stringify(partLines)) {
      return [...wholeLines.slice(0, i), ...replaceLines, ...wholeLines.slice(i + partLen)].join(
        ''
      );
    }
  }
  return null;
}

function tryDotdotdots(whole: string, part: string, replace: string): string | null {
  /**
   * See if the edit block has ... lines.
   * If not, return null
   * If yes, try and do a perfect edit with the ... chunks.
   * If there's a mismatch or otherwise imperfect edit, throw an Error.
   * If perfect edit succeeds, return the updated whole.
   */

  const dotsRe = /^\s*\.\.\.\n/gm;

  const partPieces = part.split(dotsRe);
  const replacePieces = replace.split(dotsRe);

  if (partPieces.length !== replacePieces.length) {
    return null;
  }

  if (partPieces.length === 1) {
    return null;
  }

  // Filter out the ... markers, keeping only the content pieces
  const partContentPieces = partPieces.filter((_, i) => i % 2 === 0);
  const replaceContentPieces = replacePieces.filter((_, i) => i % 2 === 0);

  // Compare odd strings (the ... markers) in partPieces and replacePieces
  const allDotsMatch = partPieces.every((piece, i) =>
    i % 2 === 1 ? piece === replacePieces[i] : true
  );

  if (!allDotsMatch) {
    return null;
  }

  let result = whole;
  const pairs = partContentPieces.map(
    (part, i) => [part, replaceContentPieces[i]] as [string, string]
  );

  for (const [partPiece, replacePiece] of pairs) {
    if (!partPiece && !replacePiece) {
      continue;
    }

    if (!partPiece && replacePiece) {
      if (!result.endsWith('\n')) {
        result += '\n';
      }
      result += replacePiece;
      continue;
    }

    const partCount = (
      result.match(new RegExp(partPiece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []
    ).length;
    if (partCount === 0 || partCount > 1) {
      return null;
    }

    // Replace the first occurrence
    result = result.replace(partPiece, replacePiece);
  }

  return result;
}

function replacePartWithMissingLeadingWhitespace(
  wholeLines: string[],
  partLines: string[],
  replaceLines: string[]
): string | null {
  // GPT often messes up leading whitespace.
  // It usually does it uniformly across the ORIG and UPD blocks.
  // Either omitting all leading whitespace, or including only some of it.

  // Outdent everything in partLines and replaceLines by the max fixed amount possible
  const leading: number[] = [
    ...partLines.filter((p) => p.trim()).map((p) => p.length - p.trimStart().length),
    ...replaceLines.filter((p) => p.trim()).map((p) => p.length - p.trimStart().length),
  ];

  let numLeading = 0;
  if (leading.length && Math.min(...leading) > 0) {
    numLeading = Math.min(...leading);
    partLines = partLines.map((p) => p.slice(numLeading).trimEnd() + '\n');
    replaceLines = replaceLines.map((p) => p.slice(numLeading).trimEnd() + '\n');
  }

  // Can we find an exact match not including the leading whitespace
  const numPartLines = partLines.length;

  for (let i = 0; i <= wholeLines.length - numPartLines; i++) {
    const addLeading = matchButForLeadingWhitespace(
      wholeLines.slice(i, i + numPartLines),
      partLines
    );

    if (addLeading === null) {
      continue;
    }

    const adjustedReplaceLines = replaceLines.map((rline) =>
      rline.trim() ? addLeading + rline : rline
    );
    const result = [
      ...wholeLines.slice(0, i),
      ...adjustedReplaceLines,
      ...wholeLines.slice(i + numPartLines),
    ].join('');
    return result;
  }

  return null;
}

function removeTrailingNewlines(lines: string[]): string[] | null {
  let last = lines.findLastIndex((line) => !!line.trim());
  if (last === -1) {
    return null;
  }
  return lines.slice(0, last + 1);
}

function replacePartWithExtraTrailingNewlines(
  wholeLines: string[],
  partLines: string[],
  replaceLines: string[]
): string | null {
  let trimmedWhole = removeTrailingNewlines(wholeLines);
  if (!trimmedWhole) {
    return null;
  }

  let trimmedPart = removeTrailingNewlines(partLines);
  if (!trimmedPart) {
    return null;
  }

  let trimmedReplace = removeTrailingNewlines(replaceLines);
  if (!trimmedReplace) {
    return null;
  }

  return perfectReplace(trimmedWhole, trimmedPart, trimmedReplace);
}

function matchButForLeadingWhitespace(wholeLines: string[], partLines: string[]): string | null {
  const num = wholeLines.length;

  // Does the non-whitespace all agree?
  if (!wholeLines.every((line, i) => line.trim() === partLines[i].trim())) {
    return null;
  }

  // Are they all offset the same?
  const addSet = new Set<string>();
  for (let i = 0; i < num; i++) {
    if (wholeLines[i].trim()) {
      const leadingLength = wholeLines[i].length - wholeLines[i].trimStart().length;
      const partLength = partLines[i].length - partLines[i].trimStart().length;
      const diff = leadingLength - partLength;
      if (diff >= 0) {
        addSet.add(wholeLines[i].slice(0, diff));
      }
    }
  }

  if (addSet.size !== 1) {
    return null;
  }

  return Array.from(addSet)[0];
}

interface EditBlock {
  filePath: string | null;
  original: string | null;
  updated: string;
}

function findOriginalUpdateBlocks(content: string, validFnames: string[] = []): EditBlock[] {
  const lines = splitLinesWithEndings(content);
  const results: EditBlock[] = [];
  let i = 0;
  let currentFilename: string | null = null;

  const headPattern = /^<{5,9} SEARCH\s*$/;
  const dividerPattern = /^={5,9}\s*$/;
  const updatedPattern = /^>{5,9} REPLACE\s*$/;

  const shellStarts = [
    '```bash',
    '```sh',
    '```shell',
    '```cmd',
    '```batch',
    '```powershell',
    '```ps1',
    '```zsh',
    '```fish',
    '```ksh',
    '```csh',
    '```tcsh',
  ];

  while (i < lines.length) {
    const line = lines[i];

    // Check for shell code blocks
    const nextIsEditBlock = i + 1 < lines.length && headPattern.test(lines[i + 1].trim());
    if (shellStarts.some((start) => line.trim().startsWith(start)) && !nextIsEditBlock) {
      const shellContent: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        shellContent.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].trim().startsWith('```')) {
        i++;
      }
      results.push({ filePath: null, original: null, updated: shellContent.join('') });
      continue;
    }

    // Check for SEARCH/REPLACE blocks
    if (headPattern.test(line.trim())) {
      try {
        // If next line after HEAD exists and is DIVIDER, it's a new file
        const isNewFileDivider = i + 1 < lines.length && dividerPattern.test(lines[i + 1].trim());
        let filename = findFilename(
          lines.slice(Math.max(0, i - 3), i),
          isNewFileDivider ? null : validFnames
        );

        if (!filename) {
          if (currentFilename) {
            filename = currentFilename;
          } else {
            throw new Error(
              `Bad/missing filename. The filename must be alone on the line before the opening fence ${fence}`
            );
          }
        } else {
          currentFilename = filename;
        }

        const originalText: string[] = [];
        i++;

        while (i < lines.length && !dividerPattern.test(lines[i].trim())) {
          originalText.push(lines[i]);
          i++;
        }

        if (i >= lines.length || !dividerPattern.test(lines[i].trim())) {
          throw new Error('Expected `=======`');
        }

        const updatedText: string[] = [];
        i++;
        while (
          i < lines.length &&
          !updatedPattern.test(lines[i].trim()) &&
          !dividerPattern.test(lines[i].trim())
        ) {
          updatedText.push(lines[i]);
          i++;
        }

        if (
          i >= lines.length ||
          (!updatedPattern.test(lines[i].trim()) && !dividerPattern.test(lines[i].trim()))
        ) {
          throw new Error('Expected `>>>>>>> REPLACE` or `=======`');
        }

        results.push({
          filePath: currentFilename,
          original: originalText.join(''),
          updated: updatedText.join(''),
        });
      } catch (e) {
        const processed = lines.slice(0, i + 1).join('');
        const err = e instanceof Error ? e.message : String(e);
        throw new Error(`${processed}\n^^^ ${err}`);
      }
    }
    i++;
  }

  return results;
}

function stripFilename(filename: string): string | undefined {
  filename = filename.trim();

  if (filename === '...') {
    return undefined;
  }

  const tripleBackticks = '```';
  if (filename.startsWith(fence) || filename.startsWith(tripleBackticks)) {
    return undefined;
  }

  filename = filename.replace(/:$/, '');
  filename = filename.replace(/^#/, '');
  filename = filename.trim();
  filename = filename.replace(/^`+|`+$/g, '');
  filename = filename.replace(/^\*+|\*+$/g, '');

  return filename;
}

function findFilename(lines: string[], validFnames: string[] | null): string | undefined {
  if (validFnames === null) {
    validFnames = [];
  }

  // Go back through the 3 preceding lines
  const reversedLines = [...lines].reverse().slice(0, 3);
  const filenames: string[] = [];

  for (const line of reversedLines) {
    const filename = stripFilename(line);
    if (filename) {
      filenames.push(filename);
    }

    // Only continue as long as we keep seeing fences
    if (!line.startsWith(fence)) {
      break;
    }
  }

  if (!filenames.length) {
    return undefined;
  }

  // Pick the *best* filename found
  // Check for exact match first
  for (const fname of filenames) {
    if (validFnames.includes(fname)) {
      return fname;
    }
  }

  // Check for partial match (basename match)
  for (const fname of filenames) {
    for (const vfn of validFnames) {
      // This is a simplified version - in a real app you'd use a Path library
      if (fname === path.basename(vfn)) {
        return vfn;
      }
    }
  }

  // Perform fuzzy matching with validFnames
  for (const fname of filenames) {
    const closeMatches = getCloseMatches(fname, validFnames, 1, 0.8);
    if (closeMatches.length === 1) {
      return closeMatches[0];
    }
  }

  // If no fuzzy match, look for a file w/extension
  for (const fname of filenames) {
    if (fname.includes('.')) {
      return fname;
    }
  }

  return filenames[0];
}

function getCloseMatches(
  target: string,
  candidates: string[],
  n: number,
  cutoff: number
): string[] {
  const matches = stringComparison.diceCoefficient.sortMatch(target, candidates);
  const topMatches = matches
    .filter((r) => r.rating >= cutoff)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, n)
    .map((r) => r.member);
  return topMatches;
}
