import { describe, expect, it } from 'bun:test';
import stripAnsi from 'strip-ansi';
import type { ExecutionSummary } from './types.js';

describe('displayExecutionSummary', () => {

  it('renders an overview table, steps, files and no errors on success', async () => {
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
    const out = stripAnsi(formatExecutionSummaryToLines(summary).join('\n'));

    expect(out).toContain('Execution Summary: My Plan');
    expect(out).toContain('Plan ID');
    expect(out).toContain('42');
    expect(out).toContain('Steps Executed');
    expect(out).toContain('1');
    expect(out).toContain('Failed Steps');
    expect(out).toContain('0');

    // Step section
    expect(out).toContain('Step Results');
    expect(out).toContain('Step A');
    expect(out).toContain('claude_code');
    expect(out).toContain('Final assistant message');

    // File section
    expect(out).toContain('File Changes');
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
      steps: [
        { title: 'Iter 1', executor: 'codx_cli', success: false, errorMessage: 'boom' },
      ],
      changedFiles: [],
      errors: ['Failed to track file changes'],
      metadata: { totalSteps: 1, failedSteps: 1, batchIterations: 1 },
    };

    const { formatExecutionSummaryToLines } = await import('./display.js');
    const out = stripAnsi(formatExecutionSummaryToLines(summary).join('\n'));

    expect(out).toContain('Execution Summary: Err Plan');
    expect(out).toContain('Mode');
    expect(out).toContain('batch');
    expect(out).toContain('File Changes');
    expect(out).toContain('No changed files detected.');
    expect(out).toContain('Errors');
    expect(out).toContain('Failed to track file changes');
    expect(out).toContain('boom');
  });
});
