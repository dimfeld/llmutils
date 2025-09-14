import chalk from 'chalk';
import { table } from 'table';
import { boldMarkdownHeaders, log } from '../../logging.js';
import type { ExecutionSummary, StepResult } from './types.js';

function formatDuration(ms?: number): string {
  if (ms == null) return 'n/a';
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function divider(): string {
  return '─'.repeat(60);
}

function stepStatusIcon(s: StepResult): string {
  return s.success ? chalk.green('✔') : chalk.red('✖');
}

function summarizeSteps(steps: StepResult[]): string[] {
  const lines: string[] = [];
  for (const [idx, s] of steps.entries()) {
    const header = `${stepStatusIcon(s)} ${chalk.bold(s.title)} ${chalk.gray(`(${s.executor})`)} ${chalk.gray(`[#${idx + 1}]`)}  ${chalk.gray(formatDuration(s.durationMs))}`;
    lines.push(header);
    if (s.errorMessage) {
      lines.push(chalk.red(`  Error: ${s.errorMessage}`));
    }
    if (s.output?.content) {
      const excerpt = s.output.content.trim();
      if (excerpt) {
        // Indent output lines
        const indented = excerpt.split('\n').map((l) => `  ${l}`).join('\n');
        lines.push(indented);
      }
    }
    lines.push('');
  }
  return lines;
}

/**
 * Writes a formatted execution summary to the logger (stdout).
 */
export function displayExecutionSummary(summary: ExecutionSummary): void {
  try {
    const statusColor = summary.metadata.failedSteps > 0 ? chalk.red : chalk.green;
    const title = statusColor(`Execution Summary: ${summary.planTitle}`);
    log(boldMarkdownHeaders(`\n# ${title}`));
    log(divider());

    // Overview table
    const tableData = [
      [chalk.bold('Plan ID'), summary.planId],
      [chalk.bold('Mode'), summary.mode],
      [chalk.bold('Steps Executed'), String(summary.metadata.totalSteps)],
      [chalk.bold('Failed Steps'), String(summary.metadata.failedSteps)],
      [chalk.bold('Files Changed'), String(summary.changedFiles.length)],
      [chalk.bold('Duration'), formatDuration(summary.durationMs)],
    ];

    const tableConfig = {
      border: {
        topBody: '─',
        topJoin: '┬',
        topLeft: '┌',
        topRight: '┐',
        bottomBody: '─',
        bottomJoin: '┴',
        bottomLeft: '└',
        bottomRight: '┘',
        bodyLeft: '│',
        bodyRight: '│',
        bodyJoin: '│',
        joinBody: '─',
        joinLeft: '├',
        joinRight: '┤',
        joinJoin: '┼',
      },
    } as const;

    log(table(tableData, tableConfig));

    // Steps
    if (summary.steps.length > 0) {
      log(chalk.bold.cyan('Step Results'));
      log(divider());
      for (const line of summarizeSteps(summary.steps)) {
        log(line);
      }
    }

    // Files
    log(chalk.bold.cyan('File Changes'));
    log(divider());
    if (summary.changedFiles.length === 0) {
      log(chalk.gray('No changed files detected.'));
    } else {
      for (const f of summary.changedFiles) {
        log(`${chalk.yellow('•')} ${f}`);
      }
    }

    // Errors
    if (summary.errors.length > 0) {
      log(chalk.bold.red('Errors'));
      log(divider());
      for (const e of summary.errors) {
        log(`${chalk.red('•')} ${e}`);
      }
    }
  } catch (e) {
    // Rendering errors should never break execution
    log(chalk.yellow(`Warning: Failed to display summary: ${e instanceof Error ? e.message : String(e)}`));
  }
}

