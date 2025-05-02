import { processRawFiles } from '../editor/whole-file/parse_raw_edits.ts';
import { processXmlContents } from '../editor/xml/parse_xml.ts';
import { processSearchReplace } from '../editor/diff-editor/parse.ts';
import { processUnifiedDiff } from '../editor/udiff-simple/parse.ts';
import { getGitRoot, secureWrite } from '../rmfilter/utils.ts';
import type { EditResult, NoMatchFailure, NotUniqueFailure } from '../editor/types.js';
import { resolveFailuresInteractively } from './interactive.js';
import { log, error } from '../logging.ts';
import { printDetailedFailures } from './failures.ts';
import * as path from 'node:path';

export interface ApplyLlmEditsOptions {
  content: string;
  writeRoot?: string;
  dryRun?: boolean;
  mode?: 'diff' | 'udiff' | 'xml' | 'whole';
  interactive?: boolean;
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
  mode,
}: {
  content: string;
  writeRoot: string;
  dryRun: boolean;
  mode?: 'diff' | 'udiff' | 'xml' | 'whole';
}): Promise<EditResult[] | undefined> {
  const xmlMode = mode === 'xml' || (!mode && content.includes('<code_changes>'));
  const diffMode = mode === 'diff' || (!mode && content.includes('<<<<<<< SEARCH'));
  const udiffMode =
    mode === 'udiff' ||
    (!mode &&
      (content.startsWith('--- ') || content.includes('```diff')) &&
      content.includes('@@'));

  if (udiffMode) {
    log('Processing as Unified Diff...');
    return await processUnifiedDiff({ content, writeRoot, dryRun });
  } else if (diffMode) {
    log('Processing as Search/Replace Diff...');
    return await processSearchReplace({ content, writeRoot, dryRun });
  } else if (xmlMode) {
    log('Processing as XML Whole Files...');
    await processXmlContents({ content, writeRoot, dryRun });
    return undefined;
  } else {
    log('Processing as Whole Files...');
    await processRawFiles({ content, writeRoot, dryRun });
    return undefined;
  }
}
export async function applyLlmEdits({
  content,
  writeRoot,
  dryRun,
  mode,
  interactive,
}: ApplyLlmEditsOptions) {
  // Resolve writeRoot early as it's needed for interactive mode too
  writeRoot ??= await getWriteRoot();

  // Call the internal function to apply edits
  const results = await applyEditsInternal({
    content,
    writeRoot,
    dryRun: dryRun ?? false,
    mode,
  });

  // Handle results if available (currently only from udiff and diff modes)
  if (results) {
    const failures = results.filter(
      (r): r is NoMatchFailure | NotUniqueFailure => r.type === 'noMatch' || r.type === 'notUnique'
    );

    // Check for not unique failures where the number of edits matches the number of match locations
    const notUniqueFailures = failures.filter((r): r is NotUniqueFailure => r.type === 'notUnique');
    const groupedByEdit = new Map<string, NotUniqueFailure[]>();
    for (const failure of notUniqueFailures) {
      const key = `${failure.filePath}:${failure.originalText}:${failure.updatedText}`;
      const group = groupedByEdit.get(key) || [];
      group.push(failure);
      groupedByEdit.set(key, group);
    }

    const autoApplied: EditResult[] = [];
    for (const group of groupedByEdit.values()) {
      const totalLocations = group[0].matchLocations.length;
      if (group.length === totalLocations) {
        // Apply the same edit to all match locations
        for (const failure of group) {
          // Sort match locations by start line in descending so we
          // don't have to specially account for deltas.
          failure.matchLocations.sort((a, b) => b.startLine - a.startLine);

          const fileContent = await Bun.file(path.resolve(writeRoot, failure.filePath)).text();
          let lines = fileContent.split('\n');
          for (const loc of failure.matchLocations) {
            const beforeLines = failure.originalText.split('\n');
            const afterLines = failure.updatedText.split('\n');
            const startLine = loc.startLine - 1;
            const endLine = startLine + beforeLines.length;

            // Verify the text at the location still matches
            const currentText = lines.slice(startLine, endLine).join('\n');
            if (currentText === failure.originalText) {
              lines.splice(startLine, beforeLines.length, ...afterLines);
              log(`Applying diff to ${failure.filePath}`);
              autoApplied.push({
                type: 'success',
                filePath: failure.filePath,
                originalText: failure.originalText,
                updatedText: failure.updatedText,
              });
            } else {
              log(
                `Skipped diff for ${failure.filePath}: Text no longer matches at line ${loc.startLine}`
              );
            }
          }

          if (!dryRun) {
            await secureWrite(writeRoot, failure.filePath, lines.join('\n'));
          }
        }
      }
    }

    // Filter out failures that were auto-applied
    const remainingFailures = failures.filter(
      (f) =>
        !autoApplied.some(
          (a) =>
            a.filePath === f.filePath &&
            a.originalText === f.originalText &&
            a.updatedText === f.updatedText
        )
    );

    if (remainingFailures.length > 0) {
      if (interactive) {
        await resolveFailuresInteractively(remainingFailures, writeRoot, dryRun ?? false);
      } else {
        // Non-interactive: Log detailed errors and throw
        printDetailedFailures(remainingFailures);
        throw new Error(
          `Failed to apply ${remainingFailures.length} edits. Run with --interactive to resolve.`
        );
      }
    } else {
      log('All edits applied successfully.');
    }

    // Combine auto-applied results with original results, excluding auto-applied failures
    const finalResults = [
      ...results.filter(
        (r) =>
          r.type === 'success' ||
          !autoApplied.some(
            (a) =>
              a.filePath === r.filePath &&
              a.originalText === r.originalText &&
              a.updatedText === r.updatedText
          )
      ),
      ...autoApplied,
    ];
    // TODO: Return finalResults or use them somehow? Currently unused.
  } else {
    // Handle cases where applyEditsInternal returned undefined (whole file modes)
    // Currently, these modes don't produce results to check for failures in the same way.
    // If future whole-file modes need failure handling, it would go here.
    await processRawFiles({
      content,
      writeRoot,
      dryRun,
    });
  }
}

export async function getWriteRoot(cwd?: string) {
  return cwd || (await getGitRoot()) || process.cwd();
}
