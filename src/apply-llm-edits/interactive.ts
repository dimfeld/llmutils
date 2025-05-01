import { select } from '@inquirer/prompts';
import * as diff from 'diff';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import type {
  NoMatchFailure,
  NotUniqueFailure,
  MatchLocation,
  ClosestMatchResult,
} from '../editor/types.js';
import { secureWrite, validatePath } from '../rmfilter/utils.js';
import { log, warn, error } from '../logging.js';

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

async function applyEdit(
  failure: NoMatchFailure | NotUniqueFailure,
  targetLines: string[],
  startLineIndex: number,
  writeRoot: string,
  dryRun: boolean
): Promise<boolean> {
  const absoluteFilePath = validatePath(writeRoot, failure.filePath);
  try {
    const currentContent = await Bun.file(absoluteFilePath).text();
    const currentLines = splitLinesWithEndings(currentContent);
    const updatedLines = splitLinesWithEndings(failure.updatedText);

    // Basic check: ensure the lines we intend to replace still exist at the expected location
    // This is a simplified check; more robust checks might compare content.
    if (startLineIndex + targetLines.length > currentLines.length) {
      error(
        `Error applying edit to ${failure.filePath}: Line range ${startLineIndex + 1}-${startLineIndex + targetLines.length + 1} is out of bounds (file has ${currentLines.length} lines). Edit may be stale.`
      );
      return false;
    }

    // Verify content match (optional but recommended)
    // for (let i = 0; i < targetLines.length; i++) {
    //     if (currentLines[startLineIndex + i] !== targetLines[i]) {
    //         warn(`Warning: Content mismatch at line ${startLineIndex + i + 1} in ${failure.filePath}. Applying anyway.`);
    //         // Optionally, add a stricter check or prompt again
    //         break;
    //     }
    // }

    const newContentLines = [
      ...currentLines.slice(0, startLineIndex),
      ...updatedLines,
      ...currentLines.slice(startLineIndex + targetLines.length),
    ];

    const newContent = newContentLines.join('');

    if (dryRun) {
      log(
        chalk.cyan(
          `[Dry Run] Would apply edit to ${failure.filePath} at line ${startLineIndex + 1}`
        )
      );
      // Optionally show a diff preview in dry run
      const patch = diff.createPatch(failure.filePath, currentContent, newContent, '', '', {
        context: 3,
      });
      log(patch);
      return true;
    } else {
      await secureWrite(writeRoot, failure.filePath, newContent);
      log(chalk.green(`Applied edit to ${failure.filePath} at line ${startLineIndex + 1}`));
      return true;
    }
  } catch (err: any) {
    error(`Failed to apply edit to ${failure.filePath}: ${err.message}`);
    return false;
  }
}

async function handleNoMatchFailure(
  failure: NoMatchFailure,
  writeRoot: string,
  dryRun: boolean
): Promise<void> {
  log(chalk.yellow(`\n--- Failure: No Exact Match ---`));
  log(`File: ${chalk.bold(failure.filePath)}`);
  log(`Reason: ${chalk.red('The following text block to be replaced was not found:')}`);
  log(failure.originalText);

  if (failure.closestMatch) {
    const { lines, startLine, score } = failure.closestMatch;
    log(
      chalk.cyan(
        `\nClosest match found (score: ${score.toFixed(2)}) starting at line ${startLine + 1}:`
      )
    );
    log(lines.join(''));

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
        { name: 'Apply edit at closest match location', value: 'apply' },
        { name: 'Open in Neovim diff mode (nvim -d)', value: 'diff' },
        { name: 'Skip this edit', value: 'skip' },
      ],
    });

    if (choice === 'apply') {
      await applyEdit(failure, lines, startLine, writeRoot, dryRun);
    } else if (choice === 'diff') {
      log('Opening in Neovim diff mode...');
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llmutils-diff-'));
      const originalPath = path.join(tempDir, 'original');
      const proposedPath = path.join(tempDir, 'proposed');
      try {
        // Write the *current* content around the match location to original
        const absoluteFilePath = validatePath(writeRoot, failure.filePath);
        const currentContent = await Bun.file(absoluteFilePath).text();
        const currentLines = splitLinesWithEndings(currentContent);
        // Extract a reasonable context around the closest match start line
        const context = 5;
        const originalStart = Math.max(0, startLine - context);
        const originalEnd = Math.min(currentLines.length, startLine + lines.length + context);
        const originalSnippet = currentLines.slice(originalStart, originalEnd).join('');

        await Bun.write(originalPath, originalSnippet);
        await Bun.write(proposedPath, failure.updatedText);

        log(`Run: nvim -d ${originalPath} ${proposedPath}`);
        log(`Note: This shows the proposed change vs. the closest match snippet.`);
        log(
          `      You may need to manually apply changes to the original file: ${absoluteFilePath}`
        );

        const proc = Bun.spawn(['nvim', '-d', originalPath, proposedPath], {
          stdio: ['inherit', 'inherit', 'inherit'],
        });
        await proc.exited;
        log('Neovim closed. Please ensure you saved any intended changes to the original file.');
      } catch (err: any) {
        error(`Failed to open Neovim diff: ${err.message}`);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
      // After diff, we consider the manual step done, effectively skipping automatic application.
    } else {
      log(`Skipping edit for ${failure.filePath}`);
    }
  } else {
    log(chalk.magenta('No close match could be found.'));
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
  dryRun: boolean
): Promise<void> {
  log(chalk.yellow(`\n--- Failure: Not Unique ---`));
  log(`File: ${chalk.bold(failure.filePath)}`);
  log(
    `Reason: The text block to be replaced was found in ${failure.matchLocations.length} locations.`
  );
  log(
    chalk.red(
      failure.originalText
        .split('\n')
        .map((l) => `- ${l}`)
        .join('\n')
    )
  );

  const choices = failure.matchLocations.map((match, index) => ({
    name: `Location ${index + 1} (Line ${match.startLine + 1}):\n${chalk.gray(match.contextLines.join('').trimEnd())}`,
    value: index,
  }));

  choices.push({ name: 'Skip this edit', value: -1 });

  const selectedIndex = await select({
    message: 'Select the correct location to apply the edit:',
    choices: choices,
  });

  if (selectedIndex !== -1) {
    const selectedMatch = failure.matchLocations[selectedIndex];
    const originalLines = splitLinesWithEndings(failure.originalText);
    await applyEdit(failure, originalLines, selectedMatch.startLine, writeRoot, dryRun);
  } else {
    log(`Skipping edit for ${failure.filePath}`);
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

  for (const failure of failures) {
    if (failure.type === 'noMatch') {
      await handleNoMatchFailure(failure, writeRoot, dryRun);
    } else if (failure.type === 'notUnique') {
      await handleNotUniqueFailure(failure, writeRoot, dryRun);
    }
    log(chalk.dim('---'));
  }

  log(chalk.bold.blue('Finished interactive resolution.'));
}
