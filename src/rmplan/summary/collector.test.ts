import { describe, expect, it, mock, afterEach, beforeEach } from 'bun:test';
import { ModuleMocker } from '../../testing.js';
import { SummaryCollector } from './collector.js';

const moduleMocker = new ModuleMocker(import.meta);

const mockGetGitRoot = mock(async (base?: string) => '/tmp/repo');
const mockGetCurrentCommitHash = mock(async (_root?: string) => 'abc123');
const mockGetChangedFilesBetween = mock(async (_root?: string, _from?: string) => [
  'src/file1.ts',
  'src/dir/file2.ts',
]);

describe('SummaryCollector', () => {
  beforeEach(async () => {
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mockGetGitRoot,
      getChangedFilesOnBranch: mock(async () => []),
      getCurrentCommitHash: mockGetCurrentCommitHash,
      getChangedFilesBetween: mockGetChangedFilesBetween,
    }));
  });

  afterEach(() => {
    moduleMocker.clear();
    mockGetGitRoot.mockReset();
    mockGetCurrentCommitHash.mockReset();
    mockGetChangedFilesBetween.mockReset();
  });

  it('initializes and records timing, steps, and errors', async () => {
    const collector = new SummaryCollector({
      planId: '123',
      planTitle: 'Demo Plan',
      planFilePath: 'tasks/demo.plan.yml',
      mode: 'serial',
    });

    collector.recordExecutionStart();
    collector.addStepResult({
      title: 'Step 1',
      executor: 'claude_code',
      success: true,
      output: 'final message',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1500,
    });
    collector.addError(new Error('something happened'));
    await collector.trackFileChanges();
    collector.recordExecutionEnd();

    const summary = collector.getExecutionSummary();
    expect(summary.planId).toBe('123');
    expect(summary.planTitle).toBe('Demo Plan');
    expect(summary.planFilePath).toBe('tasks/demo.plan.yml');
    expect(summary.mode).toBe('serial');
    expect(summary.startedAt).toBeTruthy();
    expect(summary.endedAt).toBeTruthy();
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);

    expect(summary.steps.length).toBe(1);
    expect(summary.steps[0].title).toBe('Step 1');
    expect(summary.steps[0].executor).toBe('claude_code');
    expect(summary.steps[0].success).toBeTrue();
    expect(summary.steps[0].output?.content).toContain('final message');

    expect(summary.errors.length).toBe(1);
    expect(summary.errors[0]).toContain('something happened');

    expect(summary.changedFiles).toEqual(['src/file1.ts', 'src/dir/file2.ts']);

    expect(summary.metadata.totalSteps).toBe(1);
    expect(summary.metadata.failedSteps).toBe(0);
  });

  it('truncates very large outputs and enforces caps', () => {
    const collector = new SummaryCollector({
      planId: 'p',
      planTitle: 'T',
      planFilePath: 'tasks/x.yml',
      mode: 'serial',
    });

    // Create a large output exceeding default truncate (100_000) used inside collector
    const large = 'A'.repeat(150_000);
    collector.addStepResult({
      title: 'Big',
      executor: 'codx_cli',
      success: true,
      output: large,
    });

    const summary = collector.getExecutionSummary();
    const content = summary.steps[0].output?.content ?? '';
    expect(content.length).toBeLessThan(151_000); // truncated plus notice
    expect(content).toContain('… truncated (showing first 100000 of 150000 chars)');
  });

  it('does not throw on git errors and records an error', async () => {
    mockGetGitRoot.mockImplementationOnce(async () => {
      throw new Error('git failed');
    });

    const collector = new SummaryCollector({
      planId: 'p2',
      planTitle: 'T2',
      planFilePath: 'tasks/y.yml',
      mode: 'batch',
    });

    await collector.trackFileChanges();
    const summary = collector.getExecutionSummary();
    expect(summary.errors.some((e) => e.includes('Failed to track file changes'))).toBeTrue();
  });
});
