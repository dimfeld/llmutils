import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock modules at the top level
const logMessages: string[] = [];

vi.mock('../../logging.ts', () => ({
  log: vi.fn((...args: any[]) => logMessages.push(args.map(String).join(' '))),
  warn: vi.fn(() => {}),
}));

vi.mock('../../common/git.ts', () => ({
  getGitRoot: vi.fn(async () => '/tmp/repo-bare'),
}));

vi.mock('./failure_detection.ts', () => ({
  parseFailedReport: vi.fn(() => ({ failed: false })),
}));

vi.mock('./codex_cli/codex_runner.ts', () => ({
  executeCodexStep: vi.fn(async () => 'BARE MODE OUTPUT'),
}));

describe('Codex CLI bare mode', () => {
  beforeEach(() => {
    logMessages.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('runs single prompt and returns output when captureOutput is "result"', async () => {
    const { executeBareMode } = await import('./codex_cli/bare_mode.js');

    const planInfo = {
      planId: 'bare-plan',
      planTitle: 'Bare Plan',
      planFilePath: '/tmp/repo-bare/plan.yml',
      executionMode: 'bare' as const,
      captureOutput: 'result' as const,
    };

    const result = await executeBareMode(
      'BARE PROMPT CONTENT',
      planInfo,
      '/tmp/repo-bare',
      undefined,
      {}
    );

    expect(result?.content).toBe('BARE MODE OUTPUT');
    expect(result?.metadata?.phase).toBe('bare');
  });

  test('runs single prompt and returns output when captureOutput is "all"', async () => {
    const { executeBareMode } = await import('./codex_cli/bare_mode.js');

    const planInfo = {
      planId: 'bare-plan',
      planTitle: 'Bare Plan',
      planFilePath: '/tmp/repo-bare/plan.yml',
      executionMode: 'bare' as const,
      captureOutput: 'all' as const,
    };

    const result = await executeBareMode(
      'BARE PROMPT CONTENT',
      planInfo,
      '/tmp/repo-bare',
      undefined,
      {}
    );

    expect(result?.content).toBe('BARE MODE OUTPUT');
    expect(result?.metadata?.phase).toBe('bare');
  });
});
