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
const mockGetChangedFilesOnBranch = mock(async (_root?: string) => ['src/only.ts']);

describe('SummaryCollector', () => {
  beforeEach(async () => {
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mockGetGitRoot,
      getChangedFilesOnBranch: mockGetChangedFilesOnBranch,
      getCurrentCommitHash: mockGetCurrentCommitHash,
      getChangedFilesBetween: mockGetChangedFilesBetween,
    }));
  });

  afterEach(() => {
    moduleMocker.clear();
    mockGetGitRoot.mockReset();
    mockGetCurrentCommitHash.mockReset();
    mockGetChangedFilesBetween.mockReset();
    mockGetChangedFilesOnBranch.mockReset();
  });

  it('initializes and records timing, steps, and errors', async () => {
    const collector = new SummaryCollector({
      planId: '123',
      planTitle: 'Demo Plan',
      planFilePath: 'tasks/demo.plan.yml',
      mode: 'serial',
    });

    collector.recordExecutionStart('/tmp/repo');
    collector.addStepResult({
      title: 'Step 1',
      executor: 'claude_code',
      success: true,
      output: { content: 'final message' },
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
      output: { content: large },
    });

    const summary = collector.getExecutionSummary();
    const content = summary.steps[0].output?.content ?? '';
    expect(content.length).toBeLessThan(151_000); // truncated plus notice
    expect(content).toContain('… truncated (showing first 100000 of 150000 chars)');
  });

  it('applies MAX_OUTPUT_LENGTH cap before display truncation and preserves metadata', () => {
    const collector = new SummaryCollector({
      planId: 'p',
      planTitle: 'T',
      planFilePath: 'tasks/x.yml',
      mode: 'serial',
    });

    const mega = 'X'.repeat(10_000_010); // > 10MB
    collector.addStepResult({
      title: 'Cap Test',
      executor: 'codex_cli',
      success: true,
      output: { content: mega, metadata: { phase: 'implementer' } },
    });
    const summary = collector.getExecutionSummary();
    const out = summary.steps[0].output?.content ?? '';
    // The truncate message should reference capped length (10_000_000) and show first 100000
    expect(out).toContain('… truncated (showing first 100000 of 10000000 chars)');
    expect(summary.steps[0].output?.metadata).toEqual({ phase: 'implementer' });
  });

  it('honors outputTruncateAt override', () => {
    const collector = new SummaryCollector({
      planId: 'p',
      planTitle: 'T',
      planFilePath: 'tasks/x.yml',
      mode: 'serial',
    });
    const data = 'Y'.repeat(1000);
    collector.addStepResult({
      title: 'Override',
      executor: 'codex_cli',
      success: true,
      output: { content: data },
      outputTruncateAt: 50,
    });
    const content = collector.getExecutionSummary().steps[0].output?.content ?? '';
    expect(content).toContain('… truncated (showing first 50 of 1000 chars)');
  });

  it('captures batch iterations via setBatchIterations', () => {
    const collector = new SummaryCollector({
      planId: 'p',
      planTitle: 'T',
      planFilePath: 'tasks/x.yml',
      mode: 'batch',
    });
    collector.setBatchIterations(3);
    const meta = collector.getExecutionSummary().metadata;
    expect(meta.batchIterations).toBe(3);
  });

  it('falls back to getChangedFilesOnBranch when baseline is unavailable', async () => {
    mockGetCurrentCommitHash.mockImplementationOnce(async () => {
      throw new Error('no hash');
    });
    const collector = new SummaryCollector({
      planId: 'p',
      planTitle: 'T',
      planFilePath: 'tasks/x.yml',
      mode: 'serial',
    });
    await collector.trackFileChanges('/tmp/repo');
    expect(mockGetChangedFilesOnBranch).toHaveBeenCalled();
    const summary = collector.getExecutionSummary();
    // Confirm fallback call occurred; content may vary by VCS
    expect(mockGetChangedFilesOnBranch).toHaveBeenCalled();
  });

  it('metadata.totalSteps always equals steps.length', () => {
    const collector = new SummaryCollector({
      planId: 'p',
      planTitle: 'T',
      planFilePath: 'tasks/x.yml',
      mode: 'serial',
    });
    collector.addStepResult({ title: 'A', executor: 'e', success: true });
    collector.addStepResult({ title: 'B', executor: 'e', success: false, errorMessage: 'x' });
    const summary = collector.getExecutionSummary();
    expect(summary.steps.length).toBe(2);
    expect(summary.metadata.totalSteps).toBe(2);
    expect(summary.metadata.failedSteps).toBe(1);
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
