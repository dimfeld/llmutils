import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import clipboard from 'clipboardy';
import * as path from 'node:path';
import { processSearchReplace } from '../editor/diff-editor/parse.js';
import type {
  EditResult,
  FailureResult,
  NoMatchFailure,
  NotUniqueFailure,
} from '../editor/types.js';
import { processUnifiedDiff } from '../editor/udiff-simple/parse.ts';
import { processRawFiles } from '../editor/whole-file/parse_raw_edits.ts';
import { processXmlContents } from '../editor/xml/parse_xml.ts';
import { debugLog, error, log, warn } from '../logging.ts';
import { getGitRoot, parseCliArgsFromString, secureWrite } from '../rmfilter/utils.ts';
import { printDetailedFailures } from './failures.ts';
import { resolveFailuresInteractively } from './interactive.ts';
import {
  constructRetryPrompt,
  constructRetryMessage,
  getOriginalRequestContext,
  type RetryRequester,
} from './retry.ts';

export interface ApplyLlmEditsOptions {
  content: string;
  writeRoot?: string;
  dryRun?: boolean;
  mode?: 'diff' | 'udiff' | 'xml' | 'whole';
  interactive?: boolean;
  applyPartial?: boolean;
  originalPrompt?: string;
  retryRequester?: RetryRequester;
  baseDir?: string;
  copyRetryPrompt?: boolean;
}

/**
 * Extracts the command-line arguments from the first <rmfilter_command> tag found in the content.
 * @param content The string content potentially containing the tag.
 * @returns An array of parsed arguments, or null if the tag is not found or empty.
 */
export function extractRmfilterCommandArgs(content: string): string[] | null {
  const match = content.match(/<rmfilter_command>(.*?)<\/rmfilter_command>/s);
  const instructionsMatch = content.match(/<instructions>(.*?)<\/instructions>/s);
  if (match && match[1]) {
    let commandString = match[1].trim();
    if (commandString) {
      if (instructionsMatch) {
        const instructions = instructionsMatch[1].trim().replaceAll('"', '\\"');
        if (instructions) {
          commandString += ` --instructions "${instructions}"`;
        }
      }

      try {
        return parseCliArgsFromString(commandString);
      } catch (e) {
        error(`Error parsing rmfilter_command content: "${commandString}"`, e);
        return null;
      }
    }
  }
  return null;
}
/**
 * Internal function to perform the core edit application logic.
 * Detects the mode and calls the appropriate processor.
 * Returns edit results for diff-based modes, undefined otherwise.
 */
export async function applyEditsInternal({
  content,
  writeRoot,
  dryRun,
  suppressLogging = false,
  mode,
}: {
  content: string;
  writeRoot: string;
  dryRun: boolean;
  suppressLogging?: boolean;
  mode?: 'diff' | 'udiff' | 'xml' | 'whole';
}): Promise<{ successes: EditResult[]; failures: FailureResult[] } | undefined> {
  const xmlMode = mode === 'xml' || (!mode && content.includes('<code_changes>'));
  const diffMode = mode === 'diff' || (!mode && content.includes('<<<<<<< SEARCH'));
  const udiffMode =
    mode === 'udiff' ||
    (!mode &&
      (content.startsWith('--- ') || content.includes('```diff')) &&
      content.includes('@@'));

  let results: EditResult[];
  if (udiffMode) {
    if (!suppressLogging) log('Processing as Unified Diff...');
    results = await processUnifiedDiff({ content, writeRoot, dryRun, suppressLogging });
  } else if (diffMode) {
    if (!suppressLogging) log('Processing as Search/Replace Diff...');
    results = await processSearchReplace({ content, writeRoot, dryRun, suppressLogging });
  } else if (xmlMode) {
    if (!suppressLogging) log('Processing as XML Whole Files...');
    await processXmlContents({ content, writeRoot, dryRun, suppressLogging });
    return undefined;
  } else {
    if (!suppressLogging) log('Processing as Whole Files...');
    await processRawFiles({ content, writeRoot, dryRun, suppressLogging });
    return undefined;
  }

  const initialApplication = await handleAutoApplyNotUnique(results, writeRoot, dryRun);
  let failures = initialApplication.remainingFailures;
  let successes = [
    ...results.filter((r) => r.type === 'success'),
    ...initialApplication.autoApplied,
  ];

  return {
    successes,
    failures,
  };
}

/**
 * Handles the auto-application of "not unique" failures when the number of
 * specified edits matches the number of found locations.
 */
async function handleAutoApplyNotUnique(
  results: EditResult[] | undefined,
  writeRoot: string,
  dryRun: boolean
): Promise<{ remainingFailures: FailureResult[]; autoApplied: EditResult[] }> {
  if (!results) {
    return { remainingFailures: [], autoApplied: [] };
  }

  const failures = results.filter((r): r is FailureResult => r.type !== 'success');
  const notUniqueFailures = failures.filter((r): r is NotUniqueFailure => r.type === 'notUnique');

  // Group failures by the exact edit content and file path
  const groupedByEdit = new Map<string, NotUniqueFailure[]>();
  for (const failure of notUniqueFailures) {
    const key = `${failure.filePath}:${failure.originalText}:${failure.updatedText}`;
    const group = groupedByEdit.get(key) || [];
    group.push(failure);
    groupedByEdit.set(key, group);
  }

  const autoApplied: EditResult[] = [];
  for (const group of groupedByEdit.values()) {
    if (group.length === 0) continue;

    // All failures in a group should have the same matchLocations list if they represent the same intended edit
    const totalLocations = group[0].matchLocations.length;

    // Check if the number of *failure objects* for this specific edit matches the number of locations found.
    // This implies the LLM provided one edit instruction per location it found for this change.
    if (group.length === totalLocations && totalLocations > 0) {
      log(
        `Auto-applying edit for "${group[0].filePath}" as it was specified ${group.length} times for ${totalLocations} locations.`
      );
      const representativeFailure = group[0];
      // Sort match locations by start line in descending order to avoid index shifts during modification
      const sortedLocations = [...representativeFailure.matchLocations].sort(
        (a, b) => b.startLine - a.startLine
      );

      try {
        const absoluteFilePath = path.resolve(writeRoot, representativeFailure.filePath);
        const fileContent = await Bun.file(absoluteFilePath).text();
        let lines = fileContent.split('\n');
        let appliedCount = 0;

        for (const loc of sortedLocations) {
          const beforeLines = representativeFailure.originalText.split('\n');
          if (beforeLines.at(-1) == '') beforeLines.pop();
          const afterLines = representativeFailure.updatedText.split('\n');
          if (afterLines.at(-1) == '') afterLines.pop();
          const startLine = loc.startLine - 1;
          const endLine = startLine + beforeLines.length;

          if (startLine < 0 || endLine >= lines.length) {
            warn(
              `Skipped auto-apply for ${representativeFailure.filePath} at line ${loc.startLine}: Invalid line range.`
            );
            continue;
          }
          const currentText = lines.slice(startLine, endLine).join('\n');
          const original = beforeLines.join('\n');
          if (currentText === original) {
            lines.splice(startLine, beforeLines.length, ...afterLines);
            appliedCount++;
            debugLog(
              `Auto-applying diff to ${representativeFailure.filePath} at line ${loc.startLine}-${endLine + 1}`
            );
          } else {
            warn(
              `Skipped auto-apply for ${representativeFailure.filePath} at line ${loc.startLine}-${endLine + 1}: Text no longer matches.`
            );
            // If one location doesn't match, abort auto-apply for this group to avoid partial application.
            appliedCount = 0;
            break;
          }
        }

        if (appliedCount === totalLocations) {
          if (!dryRun) {
            await secureWrite(writeRoot, representativeFailure.filePath, lines.join('\n'));
            log(
              chalk.green(
                `Auto-applied ${appliedCount} instances of the edit to ${representativeFailure.filePath}`
              )
            );
          } else {
            log(
              chalk.blue(
                `[Dry Run] Would auto-apply ${appliedCount} instances of the edit to ${representativeFailure.filePath}`
              )
            );
          }
          // Mark all failures in this group as auto-applied (represented as success)
          for (const failure of group) {
            autoApplied.push({
              type: 'success',
              filePath: failure.filePath,
              originalText: failure.originalText,
              updatedText: failure.updatedText,
            });
          }
        } else if (appliedCount > 0) {
          // This case (some applied, some skipped due to mismatch) means we aborted.
          warn(
            `Auto-apply for ${representativeFailure.filePath} aborted due to mismatch at one or more locations. No changes written.`
          );
        }
      } catch (err: any) {
        error(`Error during auto-apply for ${representativeFailure.filePath}: ${err.message}`);
      }
    }
  }

  // Filter out failures that were successfully auto-applied
  const remainingFailures = failures.filter(
    (f) =>
      !autoApplied.some(
        (a) =>
          a.filePath === f.filePath &&
          a.originalText === f.originalText &&
          a.updatedText === f.updatedText
      )
  );

  return { remainingFailures, autoApplied };
}

export async function applyLlmEdits({
  content,
  writeRoot,
  dryRun = false,
  applyPartial = false,
  mode,
  interactive = false,
  originalPrompt,
  baseDir = process.cwd(),
  retryRequester,
  copyRetryPrompt = false,
}: ApplyLlmEditsOptions): Promise<
  { successes: EditResult[]; failures: FailureResult[] } | undefined
> {
  writeRoot ??= await getWriteRoot();

  // Apply in dry run mode first to count up successes and failures
  let results = await applyEditsInternal({
    content,
    writeRoot,
    dryRun: true,
    suppressLogging: true,
    mode,
  });

  if (!results) {
    // For modes that don't return results (xml, whole), apply directly if no errors detected
    if (!dryRun) {
      await applyEditsInternal({
        content,
        writeRoot,
        dryRun: false,
        mode,
      });
    }
    return;
  }

  // Handle results from dry un (currently only from udiff and diff modes)
  let { successes, failures: remainingFailures } = results;
  let appliedInitialSuccesses = false;

  // --- Retry Logic ---
  if (remainingFailures.length > 0 && retryRequester) {
    // Right now we always apply initial successes first when retry is enabled
    log(`Applying ${successes.length} successful edits...`);
    appliedInitialSuccesses = true;
    if (!dryRun) {
      await applyEditsInternal({
        content,
        writeRoot,
        dryRun: false,
        mode,
      });
    }

    log(
      chalk.yellow(
        `Initial application failed for ${remainingFailures.length} edits. Attempting automatic retry via LLM...`
      )
    );

    let originalContext: string | null = null;
    try {
      originalContext = await getOriginalRequestContext(
        { content, originalPrompt },
        await getGitRoot(baseDir),
        baseDir
      );
    } catch (err: any) {
      error(chalk.red('Failed to retrieve original context for retry:'), err.message);
      warn('Proceeding without LLM retry.');
    }

    if (originalContext) {
      const retryPrompt = constructRetryPrompt(originalContext, content, remainingFailures);
      let retryResponseContent: string | null = null;
      try {
        log('Sending request to LLM for corrections...');
        retryResponseContent = await retryRequester(retryPrompt);
        log('Received retry response from LLM.');
      } catch (err: any) {
        error(chalk.red('LLM request for retry failed:'), err.message);
        warn('Proceeding without applying LLM retry response.');
      }

      if (retryResponseContent) {
        log('Applying edits from LLM retry response...');
        const retryResults = await applyEditsInternal({
          content: retryResponseContent,
          writeRoot,
          dryRun: dryRun,
          mode,
        });

        if (retryResults) {
          const finalFailures = retryResults.failures;
          const retrySuccessCount = retryResults.successes.length;

          log(
            `Retry attempt finished. ${retrySuccessCount} edits applied successfully, ${finalFailures.length} failures remain.`
          );
          remainingFailures = finalFailures;
          // Add successfully applied retry results to the overall list
          successes.push(...retryResults.successes);
        }
      }
    }
  }
  // --- End Retry Logic ---

  // If there are failures, handle according to mode and options
  if (remainingFailures.length > 0) {
    if (interactive) {
      log(
        chalk.yellow(
          `Found ${successes.length} proper edits and ${remainingFailures.length} errors in the proposed edits.`
        )
      );

      const applySuccesses =
        successes.length > 0
          ? await confirm({
              message: `Would you like to apply the successful edits before resolving errors?`,
            })
          : false;

      if (applySuccesses) {
        // Apply successful edits
        if (!dryRun && successes.length > 0) {
          log('Applying successful edits...');
          await applyEditsInternal({
            content,
            writeRoot,
            dryRun: false,
            mode,
          });
        }

        // Proceed to interactive error resolution
        await resolveFailuresInteractively(
          remainingFailures.filter(
            (f): f is NoMatchFailure | NotUniqueFailure =>
              f.type === 'noMatch' || f.type === 'notUnique'
          ),
          writeRoot,
          dryRun
        );
      } else {
        log('Exiting without applying any edits.');
        return;
      }
    } else {
      // Non-interactive mode
      printDetailedFailures(remainingFailures);

      if (applyPartial && !appliedInitialSuccesses && successes.length > 0) {
        log(`Applying ${successes.length} successful edits...`);
        appliedInitialSuccesses = true;
        if (!dryRun) {
          await applyEditsInternal({
            content,
            writeRoot,
            dryRun: false,
            mode,
          });
        }
      }

      log(chalk.red(`Failed to apply ${remainingFailures.length} edits.`));
      if (copyRetryPrompt) {
        const retryMessage = constructRetryMessage(remainingFailures);
        await clipboard.write(retryMessage);
        log(chalk.green('Retry prompt copied to clipboard.'));
      } else {
        log(`Resolution options:`);
        log(`  --interactive: Interactively resolve errors`);
        log(`  --apply-partial: Apply successful edits before resolving errors`);
        log(`  --copy-retry-prompt, --cr: Copy the retry prompt to the clipboard`);
      }

      throw new Error(`Failed to apply ${remainingFailures.length} edits.`);
    }
  } else {
    // No failures, apply all edits if not in dry run
    if (!dryRun && !appliedInitialSuccesses) {
      appliedInitialSuccesses = true;
      await applyEditsInternal({
        content,
        writeRoot,
        dryRun: false,
        mode,
      });
    }
    log('All edits applied successfully.');
  }

  return {
    successes,
    failures: remainingFailures,
  };
}

export async function getWriteRoot(cwd?: string) {
  return cwd || (await getGitRoot()) || process.cwd();
}
