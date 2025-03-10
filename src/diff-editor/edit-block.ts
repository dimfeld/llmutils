// This is a port of Aider's edit_block coder
import * as path from 'path';
import * as fs from 'fs';
import stringComparison from 'string-comparison';

// Assuming these types would come from your IO utilities
interface IO {
  readText(path: string): string;
  writeText(path: string, content: string): void;
}

interface Edit {
  path: string;
  original: string;
  updated: string;
}

export class EditBlockCoder {
  private editFormat: string = 'diff';
  private fence: [string, string] = ['```', '```'];
  private io: IO;
  private shellCommands: string[] = [];

  constructor(io: IO) {
    this.io = io;
  }

  private absRootPath(path: string): string {
    // TODO Implement your path resolution logic
    return path;
  }

  private getRelFname(fullPath: string): string {
    // TODO Implement your relative path logic
    return fullPath;
  }

  getEdits(content: string): Edit[] {
    const edits = findOriginalUpdateBlocks(
      content,
      this.fence,
      [] // TODO getInchatRelativeFiles would need to be implemented
    );

    this.shellCommands.push(
      ...edits.filter((edit) => edit.path === null).map((edit) => edit.updated)
    );

    return edits
      .filter((edit) => edit.path !== null)
      .map((edit) => ({
        path: edit.path!,
        original: edit.original!,
        updated: edit.updated,
      }));
  }

  applyEdits(edits: Edit[], dryRun: boolean = false): Edit[] | void {
    const failed: Edit[] = [];
    const passed: Edit[] = [];
    const updatedEdits: Edit[] = [];

    for (const edit of edits) {
      const { path, original, updated } = edit;
      const fullPath = this.absRootPath(path);
      let newContent: string | null = null;

      if (fs.existsSync(fullPath)) {
        const content = this.io.readText(fullPath);
        newContent = doReplace(fullPath, content, original, updated, this.fence);
      }

      if (!newContent && original.trim()) {
        // TODO Try other files in chat - implement abs_fnames logic
      }

      updatedEdits.push({ path, original, updated });

      if (newContent) {
        if (!dryRun) {
          this.io.writeText(fullPath, newContent);
        }
        passed.push(edit);
      } else {
        failed.push(edit);
      }
    }

    if (dryRun) {
      return updatedEdits;
    }

    if (!failed.length) {
      return;
    }

    throw new Error(this.formatErrorMessage(failed, passed));
  }

  private formatErrorMessage(failed: Edit[], passed: Edit[]): string {
    const blocks = failed.length === 1 ? 'block' : 'blocks';
    let res = `# ${failed.length} SEARCH/REPLACE ${blocks} failed to match!\n`;

    for (const edit of failed) {
      const { path, original, updated } = edit;
      const fullPath = this.absRootPath(path);
      const content = this.io.readText(fullPath);

      res += `
## SearchReplaceNoExactMatch: This SEARCH block failed to exactly match lines in ${path}
<<<<<<< SEARCH
${original}=======
${updated}>>>>>>> REPLACE

`;
      const similar = findSimilarLines(original, content);
      if (similar) {
        res += `Did you mean to match some of these actual lines from ${path}?

${this.fence[0]}
${similar}
${this.fence[1]}

`;
      }
    }
    return res;
  }
}

function doReplace(
  fname: string,
  content: string | null,
  beforeText: string,
  afterText: string,
  fence: [string, string]
): string | null {
  beforeText = stripQuotedWrapping(beforeText, fname, fence);
  afterText = stripQuotedWrapping(afterText, fname, fence);

  if (!fs.existsSync(fname) && !beforeText.trim()) {
    fs.writeFileSync(fname, '');
    content = '';
  }

  if (content === null) {
    return null;
  }

  if (!beforeText.trim()) {
    return content + afterText;
  }

  return replaceMostSimilarChunk(content, beforeText, afterText);
}

function stripQuotedWrapping(
  res: string,
  fname?: string,
  fence: [string, string] = ['```', '```']
): string {
  if (!res) return res;

  let lines = res.split('\n');

  if (fname && lines[0].trim().endsWith(path.basename(fname))) {
    lines = lines.slice(1);
  }

  if (lines[0].startsWith(fence[0]) && lines[lines.length - 1].startsWith(fence[1])) {
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

function prep(content: string): { content: string; lines: string[] } {
  if (content && !content.endsWith('\n')) {
    content += '\n';
  }
  const lines = content.split('\n').map((line) => line + '\n');
  return { content, lines };
}

function perfectOrWhitespace(
  wholeLines: string[],
  partLines: string[],
  replaceLines: string[]
): string | null {
  let res = perfectReplace(wholeLines, partLines, replaceLines);
  if (res) return res;

  return replacePartWithMissingLeadingWhitespace(wholeLines, partLines, replaceLines);
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

function findSimilarLines(
  searchLines: string,
  contentLines: string,
  threshold: number = 0.6
): string {
  const search = searchLines.split('\n');
  const content = contentLines.split('\n');

  let bestRatio = 0;
  let bestMatch: string[] | null = null;
  let bestMatchIndex = -1;

  for (let i = 0; i <= content.length - search.length; i++) {
    const chunk = content.slice(i, i + search.length);
    const ratio = stringComparison.diceCoefficient.similarity(search.join('\n'), chunk.join('\n'));
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestMatch = chunk;
      bestMatchIndex = i;
    }
  }

  if (bestRatio < threshold || !bestMatch) {
    return '';
  }

  if (bestMatch[0] === search[0] && bestMatch[bestMatch.length - 1] === search[search.length - 1]) {
    return bestMatch.join('\n');
  }

  const N = 5;
  const bestMatchEnd = Math.min(content.length, bestMatchIndex + search.length + N);
  const bestMatchStart = Math.max(0, bestMatchIndex - N);

  const best = content.slice(bestMatchStart, bestMatchEnd);
  return best.join('\n');
}

function tryDotdotdots(whole: string, part: string, replace: string): string | null {
  /**
   * See if the edit block has ... lines.
   * If not, return empty string.
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
    // No dots in this edit block, return empty string
    return '';
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
    partLines = partLines.map((p) => (p.trim() ? p.slice(numLeading) : p));
    replaceLines = replaceLines.map((p) => (p.trim() ? p.slice(numLeading) : p));
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

function matchButForLeadingWhitespace(wholeLines: string[], partLines: string[]): string | null {
  const num = wholeLines.length;

  // Does the non-whitespace all agree?
  if (!wholeLines.every((line, i) => line.trimStart() === partLines[i].trimStart())) {
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
  path: string | null;
  original: string | null;
  updated: string;
}

function findOriginalUpdateBlocks(
  content: string,
  fence: [string, string] = ['```', '```'],
  validFnames: string[] = []
): EditBlock[] {
  const lines = content.split('\n').map((line) => line + '\n');
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
        i++; // Skip the closing ```
      }
      results.push({ path: null, original: null, updated: shellContent.join('') });
      continue;
    }

    // Check for SEARCH/REPLACE blocks
    if (headPattern.test(line.trim())) {
      try {
        // If next line after HEAD exists and is DIVIDER, it's a new file
        const isNewFileDivider = i + 1 < lines.length && dividerPattern.test(lines[i + 1].trim());
        let filename = findFilename(
          lines.slice(Math.max(0, i - 3), i),
          fence,
          isNewFileDivider ? null : validFnames
        );

        if (!filename) {
          if (currentFilename) {
            filename = currentFilename;
          } else {
            throw new Error(
              `Bad/missing filename. The filename must be alone on the line before the opening fence ${fence[0]}`
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
          path: currentFilename,
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

function stripFilename(filename: string, fence: [string, string]): string | undefined {
  filename = filename.trim();

  if (filename === '...') {
    return undefined;
  }

  const startFence = fence[0];
  const tripleBackticks = '```';
  if (filename.startsWith(startFence) || filename.startsWith(tripleBackticks)) {
    return undefined;
  }

  filename = filename.replace(/:$/, '');
  filename = filename.replace(/^#/, '');
  filename = filename.trim();
  filename = filename.replace(/^`+|`+$/g, '');
  filename = filename.replace(/^\*+|\*+$/g, '');

  return filename;
}

function findFilename(
  lines: string[],
  fence: [string, string],
  validFnames: string[] | null
): string | undefined {
  if (validFnames === null) {
    validFnames = [];
  }

  // Go back through the 3 preceding lines
  const reversedLines = [...lines].reverse().slice(0, 3);
  const filenames: string[] = [];

  for (const line of reversedLines) {
    const filename = stripFilename(line, fence);
    if (filename) {
      filenames.push(filename);
    }

    // Only continue as long as we keep seeing fences
    if (!line.startsWith(fence[0]) && !line.startsWith('```')) {
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
    .filter((r) => r.rating >= cutoff) // Cutoff
    .sort((a, b) => b.rating - a.rating) // Sort by similarity
    .slice(0, n) // Limit to n
    .map((r) => r.member);
  return topMatches;
}
