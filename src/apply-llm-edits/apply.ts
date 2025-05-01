import { processRawFiles } from '../editor/whole-file/parse_raw_edits.ts';
import { processXmlContents } from '../editor/xml/parse_xml.ts';
import { processSearchReplace } from '../editor/diff-editor/parse.ts';
import { processUnifiedDiff } from '../editor/udiff-simple/parse.ts';
import { getGitRoot } from '../rmfilter/utils.ts';
import type { EditResult, NoMatchFailure, NotUniqueFailure } from '../editor/types.js';
import { resolveFailuresInteractively } from './interactive.js';
import { log, error } from '../logging.ts';

export interface ApplyLlmEditsOptions {
  content: string;
  writeRoot?: string;
  dryRun?: boolean;
  mode?: 'diff' | 'udiff' | 'xml' | 'whole';
  interactive?: boolean;
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
  const xmlMode = mode === 'xml' || (!mode && content.includes('<code_changes>'));
  const diffMode = mode === 'diff' || (!mode && content.includes('<<<<<<< SEARCH'));
  const udiffMode =
    mode === 'udiff' ||
    (!mode &&
      (content.startsWith('--- ') || content.includes('```diff')) &&
      content.includes('@@'));

  let results: EditResult[] | undefined;

  if (udiffMode) {
    log('Processing as Unified Diff...');
    results = await processUnifiedDiff({
      content,
      writeRoot,
      dryRun,
    });
  } else if (diffMode) {
    log('Processing as Search/Replace Diff...');
    results = await processSearchReplace({
      content,
      writeRoot,
      dryRun,
    });
  } else if (xmlMode) {
    log('Processing as XML...');
    // TODO: Update processXmlContents to return EditResult[] if needed
    await processXmlContents({
      content,
      writeRoot,
      dryRun,
    });
  } else {
    log('Processing as Raw Files...');
    // TODO: Update processRawFiles to return EditResult[] if needed
    await processRawFiles({
      content,
      writeRoot,
      dryRun,
    });
  }

  // Handle results if available (currently only from udiff and diff modes)
  if (results) {
    const failures = results.filter(
      (r): r is NoMatchFailure | NotUniqueFailure => r.type === 'noMatch' || r.type === 'notUnique'
    );

    if (failures.length > 0) {
      if (interactive) {
        await resolveFailuresInteractively(failures, writeRoot, dryRun ?? false);
      } else {
        // Non-interactive: Log errors and throw
        error(`Encountered ${failures.length} edit application failure(s):`);
        failures.forEach((failure) => {
          if (failure.type === 'noMatch') {
            error(`  - ${failure.filePath}: Edit text not found.`);
          } else if (failure.type === 'notUnique') {
            error(
              `  - ${failure.filePath}: Edit text found in multiple locations (${failure.matchLocations.length}).`
            );
          }
        });
        throw new Error(
          `Failed to apply ${failures.length} edits. Run with --interactive to resolve.`
        );
      }
    } else {
      log('All edits applied successfully.');
    }
  }
} // Added missing closing brace for the function

export async function getWriteRoot(cwd?: string) {
  return cwd || (await getGitRoot()) || process.cwd();
}
