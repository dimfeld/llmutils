import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModuleMocker } from '../../testing.js';
import type { ExecutionSummary } from './types.js';

const moduleMocker = new ModuleMocker(import.meta);

// Simple chalk mock that annotates styles for verification
const wrap = (name: string) => (s: string) => `[${name}]${s}[/${name}]`;
const chalkMock = {
  green: wrap('green'),
  yellow: wrap('yellow'),
  red: wrap('red'),
  redBright: wrap('redBright'),
  gray: wrap('gray'),
  bold: wrap('bold'),
  dim: wrap('dim'),
  cyan: wrap('cyan'),
  white: wrap('white'),
  magenta: wrap('magenta'),
  blue: wrap('blue'),
  rgb: () => wrap('rgb'),
  strikethrough: { gray: wrap('strikethrough.gray') },
};

// Mock table to a simple TSV-ish join so we can inspect structure
const mockTable = mock((data: any[]) => data.map((row) => row.join('\t')).join('\n'));

beforeEach(async () => {
  await moduleMocker.mock('chalk', () => ({ default: chalkMock }));
  await moduleMocker.mock('table', () => ({ table: mockTable }));
});

afterEach(() => {
  moduleMocker.clear();
  mockTable.mockClear();
});

describe('displayExecutionSummary', () => {
  it('renders overview, steps, files, and no errors on success', async () => {
    const summary: ExecutionSummary = {
      planId: '42',
      planTitle: 'My Plan',
      planFilePath: 'tasks/plan.yml',
      mode: 'serial',
      startedAt: new Date().toISOString(),
      endedAt: new Date(Date.now() + 1200).toISOString(),
      durationMs: 1200,
      steps: [
        {
          title: 'Step A',
          executor: 'claude_code',
          success: true,
          durationMs: 1200,
          output: { content: 'Final assistant message' },
        },
      ],
      changedFiles: ['src/a.ts', 'src/b.ts'],
      errors: [],
      metadata: { totalSteps: 1, failedSteps: 0 },
      planInfo: { planId: '42' },
    };

    const { formatExecutionSummaryToLines } = await import('./display.js');
    const out = formatExecutionSummaryToLines(summary).join('\n');

    // Title present and colored green
    expect(out).toContain('[bold][green]Execution Summary: My Plan[/green][/bold]');
    // Progress indicator
    expect(out).toMatch(/\(1\/1 • 100%\)/);
    expect(out).toContain('Plan ID');
    expect(out).toContain('42');
    expect(out).toContain('Steps Executed');
    expect(out).toContain('1');
    expect(out).toContain('Failed Steps');
    expect(out).toContain('0');

    // Step section
    expect(out).toContain('[bold][cyan]Step Results[/cyan][/bold]');
    expect(out).toContain('Step A');
    expect(out).toContain('claude_code');
    expect(out).toContain('Final assistant message');

    // File section
    expect(out).toContain('[bold][cyan]File Changes[/cyan][/bold]');
    expect(out).toContain('src/a.ts');
    expect(out).toContain('src/b.ts');

    // Should not include Errors header since none
    expect(out.includes('Errors')).toBeFalse();
  });

  it('shows errors section when present and handles empty file list', async () => {
    const summary: ExecutionSummary = {
      planId: '7',
      planTitle: 'Err Plan',
      planFilePath: 'tasks/p.yml',
      mode: 'batch',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
      steps: [{ title: 'Iter 1', executor: 'codx_cli', success: false, errorMessage: 'boom' }],
      changedFiles: [],
      errors: ['Failed to track file changes'],
      metadata: { totalSteps: 1, failedSteps: 1, batchIterations: 1 },
    };

    const { formatExecutionSummaryToLines } = await import('./display.js');
    const out = formatExecutionSummaryToLines(summary).join('\n');

    expect(out).toContain('Execution Summary: Err Plan');
    expect(out).toContain('Mode');
    expect(out).toContain('batch');
    expect(out).toContain('[bold][cyan]File Changes[/cyan][/bold]');
    expect(out).toContain('No changed files detected.');
    expect(out).toContain('[bold][red]Errors[/red][/bold]');
    expect(out).toContain('Failed to track file changes');
    expect(out).toContain('boom');
  });

  it('truncates very long step output and shows indicators, includes timestamps', async () => {
    const long = 'A'.repeat(210_001); // > 200k chars, single line for speed
    const summary: ExecutionSummary = {
      planId: '1',
      planTitle: 'Big Output',
      planFilePath: 'tasks/plan.yml',
      mode: 'serial',
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 10_000,
      steps: [
        {
          title: 'Big Step',
          executor: 'codex_cli',
          success: true,
          durationMs: 10_000,
          output: { content: long },
        },
        {
          title: 'Small Code',
          executor: 'codex_cli',
          success: true,
          durationMs: 100,
          output: { content: 'function test() { return 1; }' },
        },
      ],
      changedFiles: [],
      errors: [],
      metadata: { totalSteps: 2, failedSteps: 0 },
    };

    const { formatExecutionSummaryToLines } = await import('./display.js');
    const out = formatExecutionSummaryToLines(summary).join('\n');

    // Timestamps present in overview table
    expect(out).toContain('Started');
    expect(out).toContain('Ended');
    // Truncation marker for display-level clamp
    expect(out).toContain('… display truncated (showing first 200000 chars)');
    // Code snippet content still present after simple highlighting
    expect(out).toMatch(/test\(\)/);
  });

  it('uses red title color if non-step errors exist with no failed steps', async () => {
    const summary: ExecutionSummary = {
      planId: 'e1',
      planTitle: 'Errors Without Failed Steps',
      planFilePath: 'tasks/plan.yml',
      mode: 'serial',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 100,
      steps: [{ title: 'OK', executor: 'codex_cli', success: true, durationMs: 10 }],
      changedFiles: [],
      errors: ['post-apply failed'],
      metadata: { totalSteps: 1, failedSteps: 0 },
    };
    const { formatExecutionSummaryToLines } = await import('./display.js');
    const out = formatExecutionSummaryToLines(summary).join('\n');
    expect(out).toContain('[bold][red]Execution Summary: Errors Without Failed Steps[/red][/bold]');
  });

  it('writeOrDisplaySummary creates parent directories when writing', async () => {
    const summary: ExecutionSummary = {
      planId: 'w1',
      planTitle: 'Write Plan',
      planFilePath: 'tasks/plan.yml',
      mode: 'serial',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 50,
      steps: [],
      changedFiles: [],
      errors: [],
      metadata: { totalSteps: 0, failedSteps: 0 },
    };
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'summary-write-'));
    const target = path.join(tmp, 'nested', 'dir', 'out.txt');
    const { writeOrDisplaySummary } = await import('./display.js');
    await writeOrDisplaySummary(summary, target);
    const content = await fs.readFile(target, 'utf8');
    expect(content).toContain('Execution Summary: Write Plan');
  });
});
