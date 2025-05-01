import * as diff from 'diff';
import type { NoMatchFailure, NotUniqueFailure } from '../editor/types.js';
import { error } from '../logging.js';

/** Function to print detailed edit failures for noninteractive mode */
export function printDetailedFailures(failures: (NoMatchFailure | NotUniqueFailure)[]): void {
  error(`Encountered ${failures.length} edit application failure(s):`);
  failures.forEach((failure, index) => {
    error(`\nFailure ${index + 1}:`);
    error(`  File: ${failure.filePath}`);
    error(`  Original text to replace:`);
    error(
      failure.originalText
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')
    );

    if (failure.type === 'noMatch') {
      error(`  Reason: Text not found in file.`);
      if (failure.closestMatch) {
        const { startLine, endLine, lines, score } = failure.closestMatch;
        error(`  Closest match (score: ${score.toFixed(2)}):`);
        error(`    Line range: ${startLine + 1} to ${endLine + 1}`);
        error(`    Closest match content:`);
        error(lines.map((line, i) => `      ${startLine + 1 + i}: ${line}`).join('\n'));
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
        error(`    Diff between closest match and expected original:`);
        error(
          diffLines
            .split('\n')
            .map((line) => `      ${line}`)
            .join('\n')
        );
      } else {
        error(`  No close match found.`);
      }
    } else if (failure.type === 'notUnique') {
      error(`  Reason: Text found in multiple locations (${failure.matchLocations.length}).`);
      failure.matchLocations.forEach((loc, locIndex) => {
        error(`    Match ${locIndex + 1}:`);
        error(`      Starting at line: ${loc.startLine + 1}`);
        error(`      Context:`);
        error(
          loc.contextLines.map((line, i) => `        ${loc.startLine + 1 + i}: ${line}`).join('\n')
        );
      });
    }
  });
}
