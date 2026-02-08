import chalk from 'chalk';
import { table } from 'table';
import type { ExecutionSummary, StepResult } from './types.js';

function formatDuration(ms?: number): string {
  if (ms == null) return 'n/a';
  const sec = Math.floor(ms / 1000);
  let m = Math.floor(sec / 60);
  const s = sec % 60;

  let h = Math.floor(m / 60);
  if (h > 0) {
    m = m % 60;
    return `${h}h ${m}m ${s}s`;
  }

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
      (s) => s && typeof s === 'object' && typeof s.title === 'string' && typeof s.body === 'string'
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
    // Emphasize standardized failure details when available
    if (!s.success && s.output?.failureDetails) {
      const fd = s.output.failureDetails;
      const src = fd.sourceAgent ? ` (${fd.sourceAgent})` : '';
      if (fd.problems) lines.push(chalk.red(`  FAILED${src}: ${fd.problems}`));
      if (fd.requirements && fd.requirements.trim()) {
        lines.push(chalk.yellow('  Requirements:'));
        lines.push(
          ...fd.requirements
            .trim()
            .split('\n')
            .map((l) => `    ${highlightCodeLine(l)}`)
        );
      }
      if (fd.solutions && fd.solutions.trim()) {
        lines.push(chalk.yellow('  Possible solutions:'));
        lines.push(
          ...fd.solutions
            .trim()
            .split('\n')
            .map((l) => `    ${highlightCodeLine(l)}`)
        );
      }
    }
    // Prefer structured steps when provided
    const structured = s.output?.steps;
    const legacySections = s.output?.metadata && (s.output.metadata as any).sections;
    const sectionsToRender = isSectionList(structured)
      ? structured
      : isSectionList(legacySections)
        ? legacySections
        : undefined;
    if (sectionsToRender) {
      for (const sec of sectionsToRender) {
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

  // Display completion status with plan ID
  lines.push('');
  if (hasFailures || hasErrors) {
    lines.push(chalk.red(`✖ Execution finished for plan ${summary.planId}`));
  } else {
    lines.push(chalk.green(`✓ Completed plan ${summary.planId}`));
  }
  lines.push('');

  if (summary.errors.length > 0) {
    lines.push(sectionHeader('Errors', chalk.red));
    lines.push(divider());
    for (const e of summary.errors) {
      lines.push(`${chalk.red('•')} ${e}`);
    }
  }

  return lines;
}
