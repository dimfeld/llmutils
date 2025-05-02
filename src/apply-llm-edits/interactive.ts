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
): Promise<{ success: boolean; lineDelta: number }> {
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
      return { success: false, lineDelta: 0 };
    }

    // Calculate line delta: lines added minus lines removed
    const lineDelta = updatedLines.length - targetLines.length;

    const newContentLines = [
      ...currentLines.slice(0, startLineIndex - 1),
      ...updatedLines,
      ...currentLines.slice(startLineIndex - 1 + targetLines.length),
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
      return {
        success: true,
        // Since we're not actually writing the file, line delta remains 0
        lineDelta: 0,
      };
    } else {
      await secureWrite(writeRoot, failure.filePath, newContent);
      log(chalk.green(`Applied edit to ${failure.filePath} at line ${startLineIndex + 1}`));
      return { success: true, lineDelta };
    }
  } catch (err: any) {
    error(`Failed to apply edit to ${failure.filePath}: ${err.message}`);
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
  log(`Reason: ${chalk.red('The following text block to be replaced was not found:')}`);
  log(failure.originalText);

  if (failure.closestMatch) {
    const { lines, startLine, score } = failure.closestMatch;
    log(
      chalk.cyan(
        `\nClosest match found (score: ${score.toFixed(2)}) starting at line ${startLine}:`
      )
    );
    log(lines.join(''));

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
        { name: 'Apply edit at closest match location', value: 'apply' },
        { name: 'Open in Neovim diff mode (nvim -d)', value: 'diff' },
        { name: 'Skip this edit', value: 'skip' },
      ],
    });

    if (choice === 'apply') {
      return await applyEdit(failure, lines, startLine - 1, writeRoot, dryRun);
    } else if (choice === 'diff') {
      log('Opening in Neovim diff mode...');
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llmutils-diff-'));
      const proposedPath = path.join(tempDir, 'proposed');
      try {
        // Read the current full file content
        const absoluteFilePath = validatePath(writeRoot, failure.filePath);
        const currentContent = await Bun.file(absoluteFilePath).text();
        const currentLines = splitLinesWithEndings(currentContent);

        // Generate the proposed full file content by applying the edit
        const updatedLines = splitLinesWithEndings(failure.updatedText);
        const newContentLines = [
          ...currentLines.slice(0, startLine - 1),
          ...updatedLines,
          ...currentLines.slice(startLine - 1 + lines.length),
        ];
        const proposedContent = newContentLines.join('');

        // Write the proposed content to a temporary file
        await Bun.write(proposedPath, proposedContent);

        log(`Run: nvim -d ${absoluteFilePath} ${proposedPath}`);
        log(`Note: You can save changes directly to ${absoluteFilePath} in Neovim.`);

        const proc = Bun.spawn(['nvim', '-d', absoluteFilePath, proposedPath], {
          stdio: ['inherit', 'inherit', 'inherit'],
        });
        await proc.exited;
        log('Neovim closed. Changes may have been saved to the original file.');
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
  appliedLocationsByFile: Map<string, Set<number>>,
  dryRun: boolean
): Promise<{ success: boolean; lineDelta: number } | undefined> {
  log(chalk.yellow(`\n--- Failure: Not Unique ---`));
  log(`File: ${chalk.bold(failure.filePath)}`);
  log(
    `Reason: The text block to be replaced was found in ${failure.matchLocations.length} locations.`
  );
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

  // Filter out previously applied locations
  const choices = failure.matchLocations
    .map((match, index) => ({
      name: `Location ${index + 1} (Line ${match.startLine})`,
      value: index,
      description: match.contextLines.join(''),
    }))
    .filter((choice) => !appliedLocations.has(failure.matchLocations[choice.value].startLine));

  choices.push({ name: 'Skip this edit', value: -1, description: '' });

  const selectedIndex = await select({
    message: 'Select the correct location to apply the edit:',
    choices: choices,
  });

  if (selectedIndex !== -1) {
    const selectedMatch = failure.matchLocations[selectedIndex];
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
      result = await handleNotUniqueFailure(failure, writeRoot, appliedLocationsByFile, dryRun);
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
