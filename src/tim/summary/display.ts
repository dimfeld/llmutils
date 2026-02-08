import chalk from 'chalk';
import { log, sendStructured, warn } from '../../logging.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExecutionSummary } from './types.js';
import stripAnsi from 'strip-ansi';
import { formatExecutionSummaryToLines } from './format.js';

export { formatExecutionSummaryToLines } from './format.js';

export function displayExecutionSummary(summary: ExecutionSummary): void {
  try {
    sendStructured({
      type: 'execution_summary',
      timestamp: new Date().toISOString(),
      summary,
    });
  } catch (e) {
    warn(`Warning: Failed to display summary: ${e instanceof Error ? e.message : String(e)}`);
    try {
      for (const line of formatExecutionSummaryToLines(summary)) {
        log(line);
      }
    } catch {
      // Keep warning above as the final fallback if plain rendering also fails.
    }
  }
}

/**
 * Display the execution summary via structured output, and optionally write it to a file.
 * File write failures are warned and do not prevent summary display.
 */
export async function writeOrDisplaySummary(
  summary: ExecutionSummary,
  filePath?: string
): Promise<void> {
  displayExecutionSummary(summary);

  if (!filePath) {
    return;
  }
  try {
    // Write plain text (no ANSI codes) to files for portability/readability
    const content = stripAnsi(formatExecutionSummaryToLines(summary).join('\n'));
    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // ignore; we will try to write anyway and fall back on failure
    }
    await fs.writeFile(filePath, content, 'utf8');
    log(chalk.green(`Execution summary written to: ${filePath}`));
  } catch (e) {
    warn(
      `Failed to write execution summary to file: ${String(e instanceof Error ? e.message : e)}`
    );
  }
}
