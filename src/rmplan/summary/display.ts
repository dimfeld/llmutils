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
export function formatExecutionSummaryToLines(summary: ExecutionSummary): string[] {
  const lines: string[] = [];
  const statusColor = summary.metadata.failedSteps > 0 ? chalk.red : chalk.green;
  const title = statusColor(`Execution Summary: ${summary.planTitle}`);
  lines.push(boldMarkdownHeaders(`\n# ${title}`));
  lines.push(divider());

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

  lines.push(table(tableData, tableConfig));

  if (summary.steps.length > 0) {
    lines.push(chalk.bold.cyan('Step Results'));
    lines.push(divider());
    lines.push(...summarizeSteps(summary.steps));
  }

  lines.push(chalk.bold.cyan('File Changes'));
  lines.push(divider());
  if (summary.changedFiles.length === 0) {
    lines.push(chalk.gray('No changed files detected.'));
  } else {
    for (const f of summary.changedFiles) {
      lines.push(`${chalk.yellow('•')} ${f}`);
    }
  }

  if (summary.errors.length > 0) {
    lines.push(chalk.bold.red('Errors'));
    lines.push(divider());
    for (const e of summary.errors) {
      lines.push(`${chalk.red('•')} ${e}`);
    }
  }

  return lines;
}

export function displayExecutionSummary(summary: ExecutionSummary): void {
  try {
    for (const line of formatExecutionSummaryToLines(summary)) {
      log(line);
    }
  } catch (e) {
    log(chalk.yellow(`Warning: Failed to display summary: ${e instanceof Error ? e.message : String(e)}`));
  }
}
