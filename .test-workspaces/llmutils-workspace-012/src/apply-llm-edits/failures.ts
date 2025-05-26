import * as diff from 'diff';
import type {
  EditResult,
  NoMatchFailure,
  NotUniqueFailure,
  ClosestMatchResult,
} from '../editor/types.js';
import { log } from '../logging.js';

/** Function to print detailed edit failures for noninteractive mode */
export function printDetailedFailures(failures: (NoMatchFailure | NotUniqueFailure)[]): void {
  log(`Encountered ${failures.length} edit application failure(s):`);
  failures.forEach((failure, index) => {
    log(`\nFailure ${index + 1}:`);
    log(`  File: ${failure.filePath}`);

    if (failure.type === 'noMatch') {
      log(`  Reason: Text not found in file.`);
      if (failure.closestMatch) {
        const { startLine, endLine, lines, score } = failure.closestMatch;
        log(`  Closest match (score: ${score.toFixed(2)}):`);
        log(`    Line range: ${startLine + 1} to ${endLine + 1}`);
        // Generate diff between closest match and original text
        const patch = diff.createPatch(
          failure.filePath,
          lines.join(''),
          failure.originalText,
          'Closest Match',
          'Expected Original',
          { context: 9999 }
        );
        // Skip the header lines (---, +++, @@) and show only the diff content
        const diffLines = patch.split('\n').slice(4).join('\n');
        log(`    Diff between closest match and expected original:`);
        log(
          diffLines
            .split('\n')
            .map((line) => `      ${line.trimEnd()}`)
            .join('\n')
        );
      } else {
        log(`  No close match found.`);
      }
    } else if (failure.type === 'notUnique') {
      log(`  Original text to replace:`);
      log(
        failure.originalText
          .split('\n')
          .map((line) => `    ${line.trimEnd()}`)
          .join('\n')
      );
      log(`  Reason: Text found in multiple locations (${failure.matchLocations.length}).`);
      failure.matchLocations.forEach((loc, locIndex) => {
        log(`    Match ${locIndex + 1}:`);
        log(`      Starting at line: ${loc.startLine + 1}`);
        log(`      Context:`);
        log(
          loc.contextLines
            .map((line, i) => `        ${loc.startLine + 1 + i}: ${line.trimEnd()}`)
            .join('\n')
        );
      });
    }
  });
}

/** Helper function to trim long text blocks for display */
function trimLines(text: string, maxLines: number = 10, contextLines: number = 5): string {
  const lines = text.split('\n');
  if (lines.length > maxLines) {
    const first = lines.slice(0, contextLines).join('\n');
    const last = lines.slice(-contextLines).join('\n');
    return `${first}\n... (trimmed ${lines.length - 2 * contextLines} lines) ...\n${last}`;
  }
  return text;
}

/**
 * Formats edit failures into a string suitable for an LLM prompt,
 * explaining what went wrong and providing context.
 */
export function formatFailuresForLlm(failures: (NoMatchFailure | NotUniqueFailure)[]): string {
  const failureDescriptions: string[] = [];
  const header = 'The following edit(s) failed to apply:\n';

  failures.forEach((failure, index) => {
    let description = `Failure ${index + 1}:\n`;
    description += `  File: ${failure.filePath}\n`;

    const trimmedOriginal = trimLines(failure.originalText);
    description += `  Original text block intended for replacement:\n\`\`\`\n${trimmedOriginal}\n\`\`\`\n`;

    if (failure.type === 'noMatch') {
      description += `  Reason: No Exact Match - The specified text block was not found.\n`;
      if (failure.closestMatch) {
        const { startLine, endLine, lines } = failure.closestMatch;
        const trimmedClosest = trimLines(lines.join('\n'));
        description += `  Closest match found (lines ${startLine + 1}-${endLine + 1}):\n\`\`\`\n${trimmedClosest}\n\`\`\`\n`;

        // Generate and format diff
        const patch = diff.createPatch(
          failure.filePath,
          lines.join('\n'),
          failure.originalText,
          'Closest Match In File',
          'Expected Original Text',
          { context: 9999 }
        );

        // Format the patch for readability in the prompt
        const diffLines = patch
          .split('\n')
          .slice(4)
          .filter((line) => !line.startsWith('@@') && line !== '\\ No newline at end of file')
          .map((line) => `    ${line}`)
          .join('\n')
          .trimEnd();

        if (diffLines.trim()) {
          description += `  Diff between closest match and expected original text:\n\`\`\`diff\n${diffLines}\n\`\`\`\n`;
        } else {
          description += `  Note: Closest match appears identical to expected text, but failed application (possibly due to whitespace or line ending differences).\n`;
        }
      } else {
        description += `  No close match could be identified in the file.\n`;
      }
    } else if (failure.type === 'notUnique') {
      description += `  Reason: Not Unique - The specified text block was found in ${failure.matchLocations.length} locations.\n`;
      failure.matchLocations.forEach((loc, locIndex) => {
        description += `    Match ${locIndex + 1} starting at line ${loc.startLine + 1}:\n`;
        // Indent context lines for clarity
        const context = loc.contextLines
          .map((line, i) => `      ${loc.startLine + 1 + i}: ${line}`)
          .join('\n');
        description += `      Context:\n${context}\n`;
      });
      description += `  The edit was ambiguous because the same original text appeared in multiple edits. Please generate the edits again with additional surrounding context to help uniquely identify the location.\n`;
    }

    failureDescriptions.push(description);
  });

  if (failureDescriptions.length === 0) {
    return 'No failures to report.';
  }

  return header + failureDescriptions.join('\n---\n');
}
