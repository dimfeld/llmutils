import chalk from 'chalk';
import { table } from 'table';
import { log, warn } from '../../logging.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExecutionSummary, StepResult } from './types.js';
import stripAnsi from 'strip-ansi';

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

// Keep the display clamp above collector truncation (100k) to avoid hiding its notice
const MAX_STEP_DISPLAY_CHARS = 200_000;

function percent(n: number, d: number): string {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return '0%';
  const p = Math.round((n / d) * 100);
  return `${p}%`;
}

function formatTimestamp(iso?: string): string {
  if (!iso) return 'n/a';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'n/a';
    return d.toLocaleString();
  } catch {
    return 'n/a';
  }
}

function sectionHeader(title: string, color: (s: string) => string = chalk.bold): string {
  return chalk.bold(color(title));
}

// Very light syntax highlighting for common code keywords
function highlightCodeLine(line: string): string {
  // Simple heuristics; keep fast and low-cost
  const kw =
    /\b(function|class|const|let|var|import|export|return|if|else|for|while|try|catch|async|await|def)\b/g;
  return line.replace(kw, (m) => chalk.cyan(m));
}

function isSectionList(val: unknown): val is Array<{ title: string; body: string }> {
  return (
    Array.isArray(val) &&
    val.every(
      (s) =>
        s &&
        typeof s === 'object' &&
        typeof (s as any).title === 'string' &&
        typeof (s as any).body === 'string'
    )
  );
}

function summarizeSteps(steps: StepResult[]): string[] {
  const lines: string[] = [];
  for (const [idx, s] of steps.entries()) {
    const header = `${stepStatusIcon(s)} ${chalk.bold(s.title)} ${chalk.gray(`(${s.executor})`)} ${chalk.gray(`[#${idx + 1}]`)}  ${chalk.gray(formatDuration(s.durationMs))}`;
    lines.push(header);
    if (s.errorMessage) {
      lines.push(chalk.red(`  Error: ${s.errorMessage}`));
    }
    const sections = s.output?.metadata && (s.output.metadata as any).sections;
    if (isSectionList(sections)) {
      for (const sec of sections) {
        lines.push(`  ${chalk.bold(sec.title)}`);
        const body = sec.body.trim();
        if (body) {
          const indented = body
            .split('\n')
            .map((l) => `    ${highlightCodeLine(l)}`)
            .join('\n');
          lines.push(indented);
        }
        lines.push('');
      }
    } else if (s.output?.content) {
      let excerpt = s.output.content.trim();
      if (excerpt.length > MAX_STEP_DISPLAY_CHARS) {
        excerpt =
          excerpt.slice(0, MAX_STEP_DISPLAY_CHARS) +
          `\n\n… display truncated (showing first ${MAX_STEP_DISPLAY_CHARS} chars)`;
      }
      if (excerpt) {
        // Indent output lines
        const indented = excerpt
          .split('\n')
          .map((l) => `  ${highlightCodeLine(l)}`)
          .join('\n');
        lines.push(indented);
      }
    }
    lines.push('');
  }
  return lines;
}

/**
 * Formats an execution summary into displayable lines.
 * The caller is responsible for writing these lines to stdout or a file.
 */
export function formatExecutionSummaryToLines(summary: ExecutionSummary): string[] {
  const lines: string[] = [];
  const hasFailures = summary.metadata.failedSteps > 0;
  const hasErrors = summary.errors.length > 0;
  const statusColor = hasFailures || hasErrors ? chalk.red : chalk.green;
  const completed = summary.metadata.totalSteps - summary.metadata.failedSteps;
  const pct = percent(completed, summary.metadata.totalSteps || 0);
  const title = statusColor(`Execution Summary: ${summary.planTitle}`);
  lines.push(
    `\n${chalk.bold(title)} ${chalk.gray(`(${completed}/${summary.metadata.totalSteps} • ${pct})`)}`
  );
  lines.push(divider());

  const tableData = [
    [chalk.bold('Plan ID'), summary.planId],
    [chalk.bold('Mode'), summary.mode],
    [chalk.bold('Steps Executed'), String(summary.metadata.totalSteps)],
    [chalk.bold('Failed Steps'), String(summary.metadata.failedSteps)],
    [chalk.bold('Files Changed'), String(summary.changedFiles.length)],
    [chalk.bold('Duration'), formatDuration(summary.durationMs)],
    [chalk.bold('Started'), formatTimestamp(summary.startedAt)],
    [chalk.bold('Ended'), formatTimestamp(summary.endedAt)],
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
    // Stats
    const avgMs = Math.round(
      summary.steps.reduce((a, s) => a + (s.durationMs || 0), 0) / summary.steps.length || 0
    );
    lines.push(sectionHeader('Step Results', chalk.cyan));
    lines.push(divider());
    lines.push(
      chalk.gray(
        `Steps: ${completed}/${summary.metadata.totalSteps} completed • Avg Step: ${formatDuration(avgMs)}`
      )
    );
    lines.push('');
    lines.push(...summarizeSteps(summary.steps));
  }

  lines.push(sectionHeader('File Changes', chalk.cyan));
  lines.push(divider());
  if (summary.changedFiles.length === 0) {
    lines.push(chalk.gray('No changed files detected.'));
  } else {
    for (const f of summary.changedFiles) {
      lines.push(`${chalk.yellow('•')} ${f}`);
    }
  }

  if (summary.errors.length > 0) {
    lines.push(sectionHeader('Errors', chalk.red));
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
    warn(`Warning: Failed to display summary: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Write the summary to a file if a path is provided, otherwise display to stdout.
 * Falls back to display if writing fails.
 */
export async function writeOrDisplaySummary(
  summary: ExecutionSummary,
  filePath?: string
): Promise<void> {
  if (!filePath) {
    return displayExecutionSummary(summary);
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
    displayExecutionSummary(summary);
  }
}
