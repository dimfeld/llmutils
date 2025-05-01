import * as diff from 'diff';
import type { NoMatchFailure, NotUniqueFailure } from '../editor/types.js';
import { log } from '../logging.js';

/** Function to print detailed edit failures for noninteractive mode */
export function printDetailedFailures(failures: (NoMatchFailure | NotUniqueFailure)[]): void {
  log(`Encountered ${failures.length} edit application failure(s):`);
  failures.forEach((failure, index) => {
    log(`\nFailure ${index + 1}:`);
    log(`  File: ${failure.filePath}`);
    log(`  Original text to replace:`);
    log(
      failure.originalText
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')
    );

    if (failure.type === 'noMatch') {
      log(`  Reason: Text not found in file.`);
      if (failure.closestMatch) {
        const { startLine, endLine, lines, score } = failure.closestMatch;
        log(`  Closest match (score: ${score.toFixed(2)}):`);
        log(`    Line range: ${startLine + 1} to ${endLine + 1}`);
        log(`    Closest match content:`);
        log(lines.map((line, i) => `      ${startLine + 1 + i}: ${line.trimEnd()}`).join('\n'));
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
            .map((line) => `      ${line}`)
            .join('\n')
        );
      } else {
        log(`  No close match found.`);
      }
    } else if (failure.type === 'notUnique') {
      log(`  Reason: Text found in multiple locations (${failure.matchLocations.length}).`);
      failure.matchLocations.forEach((loc, locIndex) => {
        log(`    Match ${locIndex + 1}:`);
        log(`      Starting at line: ${loc.startLine + 1}`);
        log(`      Context:`);
        log(
          loc.contextLines.map((line, i) => `        ${loc.startLine + 1 + i}: ${line}`).join('\n')
        );
      });
    }
  });
}
