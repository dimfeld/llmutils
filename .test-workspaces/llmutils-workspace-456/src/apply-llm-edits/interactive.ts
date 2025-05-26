import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import * as diff from 'diff';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findClosestMatches } from '../editor/closest_match.js';
import type { EditResult, NoMatchFailure, NotUniqueFailure } from '../editor/types.js';
import { debugLog, error, log } from '../logging.js';
import { secureWrite, validatePath } from '../rmfilter/utils.js';
import { findAllMatches } from '../editor/udiff-simple/parse.js';

// Helper function to split lines while preserving line endings
function splitLinesWithEndings(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push(text.substring(start, i + 1));
      start = i + 1;
    } else if (text[i] === '\r') {
      if (i + 1 < text.length && text[i + 1] === '\n') {
        lines.push(text.substring(start, i + 2));
        start = i + 2;
        i++;
      } else {
        lines.push(text.substring(start, i + 1));
        start = i + 1;
      }
    }
  }
  if (start < text.length) {
    lines.push(text.substring(start));
  }
  // Handle case where the file ends with a newline - splitLines might produce an empty string at the end
  if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) {
    // This logic might need refinement depending on desired behavior for trailing newlines
  } else if (lines.length === 0 && text.length > 0) {
    // Handle single-line file without newline
    lines.push(text);
  }
  return lines;
}

export async function applyEditResult(edit: EditResult, writeRoot: string, dryRun: boolean) {
  const absoluteFilePath = validatePath(writeRoot, edit.filePath);
  try {
    const currentContent = await Bun.file(absoluteFilePath).text();
    const currentLines = splitLinesWithEndings(currentContent);
    const targetLines = splitLinesWithEndings(edit.originalText);
    const updatedLines = splitLinesWithEndings(edit.updatedText);

    // Search for the closest match lines in the current file content
    const [bestMatch] = findClosestMatches(currentContent, targetLines, {
      maxMatches: 1,
    });

    if (!bestMatch) {
      error(`Original text not found in ${edit.filePath}. Edit may be stale.`);
      return;
    }

    // Apply the edit
    const newContentLines = [
      // up but not including startLine
      ...currentLines.slice(0, bestMatch.startLine),
      ...updatedLines,
      // Resume after endLine
      ...currentLines.slice(bestMatch.endLine + 1),
    ];

    const newContent = newContentLines.join('');

    if (dryRun) {
      log(`[Dry Run] Would apply diff to ${edit.filePath}`);
      const patch = diff.createPatch(edit.filePath, currentContent, newContent, '', '', {
        context: 3,
      });
      log(patch);
    } else {
      await secureWrite(writeRoot, edit.filePath, newContent);
      log(chalk.green(`Applied diff to ${edit.filePath}`));
    }
  } catch (err: any) {
    error(`Failed to apply success to ${edit.filePath}: ${err.message}`);
  }
}

async function applyEdit(
  edit: EditResult,
  targetLines: string[],
  startLineIndex: number,
  writeRoot: string,
  dryRun: boolean
): Promise<{ success: boolean; lineDelta: number }> {
  const absoluteFilePath = validatePath(writeRoot, edit.filePath);
  try {
    const currentContent = await Bun.file(absoluteFilePath).text();
    const currentLines = splitLinesWithEndings(currentContent);
    const updatedLines = splitLinesWithEndings(edit.updatedText);

    // Basic check: ensure the lines we intend to replace still exist at the expected location
    // This is a simplified check; more robust checks might compare content.
    if (startLineIndex + targetLines.length >= currentLines.length) {
      error(
        `Error applying edit to ${edit.filePath}: Line range ${startLineIndex + 1}-${startLineIndex + 1 + targetLines.length} is out of bounds (file has ${currentLines.length} lines). Edit may be stale.`
      );
      return { success: false, lineDelta: 0 };
    }

    // Calculate line delta: lines added minus lines removed
    const lineDelta = updatedLines.length - targetLines.length;

    const newContentLines = [
      ...currentLines.slice(0, startLineIndex),
      ...updatedLines,
      ...currentLines.slice(startLineIndex + targetLines.length),
    ];

    const newContent = newContentLines.join('');

    if (dryRun) {
      log(`[Dry Run] Applying diff to ${edit.filePath}`);
      // Optionally show a diff preview in dry run
      const patch = diff.createPatch(edit.filePath, currentContent, newContent, '', '', {
        context: 3,
      });
      log(patch);
      return {
        success: true,
        // Since we're not actually writing the file, line delta remains 0
        lineDelta: 0,
      };
    } else {
      await secureWrite(writeRoot, edit.filePath, newContent);
      log(chalk.green(`Applying diff to ${edit.filePath}`));
      return { success: true, lineDelta };
    }
  } catch (err: any) {
    error(`Failed to apply diff to ${edit.filePath}: ${err.message}`);
    return { success: false, lineDelta: 0 };
  }
}

async function handleNoMatchFailure(
  failure: NoMatchFailure,
  writeRoot: string,
  dryRun: boolean
): Promise<{ success: boolean; lineDelta: number } | undefined> {
  log(chalk.yellow(`\n--- Failure: No Exact Match ---`));
  log(`File: ${chalk.bold(failure.filePath)}`);
  log(`Reason: ${chalk.red('The text block to be replaced was not found.')}`);

  if (failure.closestMatch) {
    // Read the current file content to find the closest match again, since a previous edit may have moved it
    const absoluteFilePath = validatePath(writeRoot, failure.filePath);
    let currentContent: string;
    try {
      currentContent = await Bun.file(absoluteFilePath).text();
    } catch (err: any) {
      error(`Failed to read file ${failure.filePath}: ${err.message}`);
      return undefined;
    }
    const currentLines = splitLinesWithEndings(currentContent);

    // Search for the closest match lines in the current file content since it may have changed
    const [bestMatch] = findClosestMatches(currentContent, failure.closestMatch.lines, {
      maxMatches: 1,
    });
    if (!bestMatch) {
      log(chalk.magenta('No close match could be found in the current file.'));
      return undefined;
    }

    const { lines, startLine, score } = bestMatch;
    log(
      chalk.cyan(
        `\nClosest match found (score: ${score.toFixed(2)}) starting at line ${startLine + 1}`
      )
    );

    // Generate diff between closest match and original text
    const diffPatch = diff.createPatch(
      failure.filePath,
      lines.join(''),
      failure.originalText,
      'Closest Match',
      'Expected Original',
      { context: 9999 }
    );
    const diffLines = diffPatch.split('\n').slice(4).join('\n');
    log(chalk.cyan('\nDiff between closest match and expected original:'));
    log(
      diffLines
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')
    );

    const patchPreview = diff
      .createPatch(failure.filePath, lines.join(''), failure.updatedText, '', '', { context: 9999 })
      .split('\n')
      .slice(4)
      .join('\n');

    log(chalk.cyan('\nProposed change at closest match location:'));
    log(patchPreview);

    const choice = await select({
      message: 'How would you like to proceed?',
      choices: [
        { name: 'Apply diff at closest match location', value: 'apply' },
        { name: 'Open in Neovim diff mode (nvim -d)', value: 'diff' },
        { name: 'Skip this diff', value: 'skip' },
      ],
    });

    if (choice === 'apply') {
      return await applyEdit(failure, lines, startLine, writeRoot, dryRun);
    } else if (choice === 'diff') {
      log('Opening in Neovim diff mode...');
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llmutils-diff-'));
      const proposedPath = path.join(tempDir, 'proposed');
      try {
        // Generate the proposed full file content by applying the edit
        const updatedLines = splitLinesWithEndings(failure.updatedText);
        const newContentLines = [
          ...currentLines.slice(0, startLine),
          ...updatedLines,
          ...currentLines.slice(startLine + lines.length),
        ];
        const proposedContent = newContentLines.join('');

        // Write the proposed content to a temporary file
        await Bun.write(proposedPath, proposedContent);

        log(`Run: nvim -d ${proposedPath} ${absoluteFilePath}`);
        log(`Note: You can save changes directly to ${absoluteFilePath} in Neovim.`);

        const proc = Bun.spawn(['nvim', '-d', proposedPath, absoluteFilePath], {
          stdio: ['inherit', 'inherit', 'inherit'],
        });
        await proc.exited;
      } catch (err: any) {
        error(`Failed to open Neovim diff: ${err.message}`);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
      // After diff, we consider the manual step done, effectively skipping automatic application.
    } else {
      log(`Skipping diff for ${failure.filePath}`);
    }
  } else {
    log(chalk.magenta('No close match could be found.'));
    // print the original diff
    const diffPatch = diff.createPatch(
      failure.filePath,
      failure.originalText,
      failure.updatedText,
      'Expected Original',
      'Proposed Change',
      { context: 9999 }
    );
    const diffLines = diffPatch.split('\n').slice(4).join('\n');
    log(chalk.magenta('Proposed change:'));
    log(
      diffLines
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')
    );
    const choice = await select({
      message: 'How would you like to proceed?',
      choices: [{ name: 'Skip this edit', value: 'skip' }],
    });
    log(`Skipping edit for ${failure.filePath}`);
  }
}

async function handleNotUniqueFailure(
  failure: NotUniqueFailure,
  writeRoot: string,
  appliedLocationsByFile: Map<string, Set<number>>,
  dryRun: boolean,
  allFailures: (NoMatchFailure | NotUniqueFailure)[],
  currentIndex: number
): Promise<{ success: boolean; lineDelta: number; obsoleted?: NotUniqueFailure[] } | undefined> {
  // Count remaining duplicate 'not unique' failures
  const duplicates = allFailures
    .slice(currentIndex + 1)
    .filter(
      (f): f is NotUniqueFailure =>
        f.type === 'notUnique' &&
        f.filePath === failure.filePath &&
        f.originalText === failure.originalText &&
        f.updatedText === failure.updatedText
    );

  debugLog(failure);

  log(chalk.yellow(`\n--- Failure: Not Unique ---`));
  log(`File: ${chalk.bold(failure.filePath)}`);
  log(
    `Reason: The text block to be replaced was found in ${failure.matchLocations.length} locations.`
  );
  if (duplicates.length > 0) {
    log(chalk.cyan(`Remaining duplicate edits with same change: ${duplicates.length}`));
  }
  log(failure.originalText);

  const diffPatch = diff.createPatch(
    failure.filePath,
    failure.originalText,
    failure.updatedText,
    'Proposed Change',
    'Expected Original',
    { context: 9999 }
  );
  const diffLines = diffPatch.split('\n').slice(4).join('\n');
  log(chalk.cyan('\nDiff between proposed change and expected original:'));
  log(
    diffLines
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
  );

  // Get or initialize the set of applied locations for this file
  let appliedLocations = appliedLocationsByFile.get(failure.filePath);
  if (!appliedLocations) {
    appliedLocations = new Set<number>();
    appliedLocationsByFile.set(failure.filePath, appliedLocations);
  }

  const fileContents = await Bun.file(failure.filePath).text();
  // Find the locations again since the file may have changed
  const matchLocations = findAllMatches(fileContents, failure.originalText);

  // Filter out previously applied locations
  const choices = matchLocations
    .map((match, index) => ({
      name: `Location ${index + 1} (Line ${match.startLine + 1})`,
      value: index,
      description: match.contextLines.join(''),
    }))
    .filter((choice) => !appliedLocations.has(matchLocations[choice.value].startLine));

  choices.push({ name: 'Apply to all matching locations', value: -2, description: '' });
  choices.push({ name: 'Skip this edit', value: -1, description: '' });

  const selectedIndex = await select({
    message: 'Select the correct location to apply the edit:',
    choices: choices,
  });

  if (selectedIndex === -2) {
    // Apply to all matching locations
    let totalLineDelta = 0;
    let success = true;
    for (const match of matchLocations) {
      if (!appliedLocations.has(match.startLine)) {
        appliedLocations.add(match.startLine);
        const originalLines = splitLinesWithEndings(failure.originalText);
        const result = await applyEdit(failure, originalLines, match.startLine, writeRoot, dryRun);
        if (result.success) {
          totalLineDelta += result.lineDelta;
        } else {
          success = false;
        }
      }
    }

    return { success, lineDelta: totalLineDelta, obsoleted: duplicates };
  } else if (selectedIndex !== -1) {
    const selectedMatch = matchLocations[selectedIndex];
    // Record the applied location
    appliedLocations.add(selectedMatch.startLine);
    const originalLines = splitLinesWithEndings(failure.originalText);
    return await applyEdit(failure, originalLines, selectedMatch.startLine, writeRoot, dryRun);
  } else {
    log(`Skipping edit for ${failure.filePath}`);
    return undefined;
  }
}
export async function resolveFailuresInteractively(
  failures: (NoMatchFailure | NotUniqueFailure)[],
  writeRoot: string,
  dryRun: boolean
): Promise<void> {
  log(
    chalk.bold.blue(`Entering interactive mode to resolve ${failures.length} edit failure(s)...`)
  );

  // Track applied locations per file
  const appliedLocationsByFile = new Map<string, Set<number>>();

  // Track cumulative line deltas per file
  const lineDeltasByFile = new Map<string, number>();

  for (let i = 0; i < failures.length; i++) {
    const failure = failures[i];

    // Apply any cumulative line delta for this file to the failure's line numbers
    const cumulativeDelta = lineDeltasByFile.get(failure.filePath) || 0;
    if (cumulativeDelta !== 0) {
      if (failure.type === 'noMatch' && failure.closestMatch) {
        failure.closestMatch.startLine += cumulativeDelta;
        failure.closestMatch.endLine += cumulativeDelta;
      } else if (failure.type === 'notUnique') {
        for (const match of failure.matchLocations) {
          match.startLine += cumulativeDelta;
        }
      }
    }

    let result;
    if (failure.type === 'noMatch') {
      result = await handleNoMatchFailure(failure, writeRoot, dryRun);
    } else if (failure.type === 'notUnique') {
      let r = await handleNotUniqueFailure(
        failure,
        writeRoot,
        appliedLocationsByFile,
        dryRun,
        failures,
        i
      );

      if (r?.obsoleted?.length) {
        failures = failures.filter((f) => !r.obsoleted?.includes(f as NotUniqueFailure));
      }

      result = r;
    }

    // Update line deltas for subsequent failures if the edit was applied
    if (result && result.success && result.lineDelta !== 0) {
      const currentDelta = lineDeltasByFile.get(failure.filePath) || 0;
      lineDeltasByFile.set(failure.filePath, currentDelta + result.lineDelta);

      const appliedLocations = appliedLocationsByFile.get(failure.filePath);
      if (appliedLocations) {
        appliedLocationsByFile.set(
          failure.filePath,
          new Set(appliedLocations.values().map((v) => v + result.lineDelta))
        );
      }
    }

    log(chalk.dim('---'));
  }

  log(chalk.bold.blue('Finished interactive resolution.'));
}
