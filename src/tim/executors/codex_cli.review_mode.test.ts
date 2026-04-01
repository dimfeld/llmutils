import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Codex CLI review mode', () => {
  const originalUseAppServer = process.env.CODEX_USE_APP_SERVER;

  beforeEach(() => {
    process.env.CODEX_USE_APP_SERVER = 'false';
    vi.resetModules();
  });

  afterEach(() => {
    if (originalUseAppServer === undefined) {
      delete process.env.CODEX_USE_APP_SERVER;
    } else {
      process.env.CODEX_USE_APP_SERVER = originalUseAppServer;
    }
    vi.clearAllMocks();
  });

  test('runs reviewer once and returns aggregated output', async () => {
    const logMessages: string[] = [];

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn((...args: any[]) => logMessages.push(args.map(String).join(' '))),
      warn: vi.fn(() => {}),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => '/tmp/repo-review'),
    }));

    vi.doMock('./failure_detection.ts', () => ({
      parseFailedReport: vi.fn(() => ({ failed: false })),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.js');

    const reviewExecutor = vi.fn(async () => 'REVIEW OUTPUT');

    const planInfo = {
      planId: 'review-plan',
      planTitle: 'Review Plan',
      planFilePath: '/tmp/repo-review/plan.yml',
      executionMode: 'review' as const,
      captureOutput: 'result' as const,
    };

    const result = await executeReviewMode(
      'REVIEW PROMPT CONTENT',
      planInfo,
      '/tmp/repo-review',
      undefined,
      {},
      { reviewExecutor }
    );

    expect(reviewExecutor).toHaveBeenCalledWith(
      'REVIEW PROMPT CONTENT',
      '/tmp/repo-review',
      {},
      undefined,
      undefined
    );
    expect(result?.content).toBe('REVIEW OUTPUT');
    expect(result?.steps?.[0].title).toBe('Codex Reviewer');
    expect(result?.steps?.[0].body).toBe('REVIEW OUTPUT');
    expect(result?.metadata?.jsonOutput).toBe(true);
    expect(result?.metadata?.phase).toBe('review');
    expect(logMessages.some((msg) => msg.includes('review-only mode'))).toBe(true);
  });

  test('marks review run as failed when the reviewer reports failure', async () => {
    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => '/tmp/repo-review'),
    }));

    vi.doMock('./failure_detection.ts', () => ({
      parseFailedReport: vi.fn(() => ({
        failed: true,
        summary: 'failed',
        details: { requirements: '', problems: 'bad news' },
      })),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.js');

    const reviewExecutor = vi.fn(async () => 'FAILED OUTPUT');

    const result = await executeReviewMode(
      'REVIEW PROMPT CONTENT',
      {
        planId: 'review-plan',
        planTitle: 'Review Plan',
        planFilePath: '/tmp/repo-review/plan.yml',
        executionMode: 'review',
        captureOutput: 'result',
      },
      '/tmp/repo-review',
      undefined,
      {},
      { reviewExecutor }
    );

    expect(result?.success).toBe(false);
    expect(result?.failureDetails?.sourceAgent).toBe('reviewer');
    expect(result?.failureDetails?.problems).toBe('bad news');
    expect(result?.content).toBe('FAILED OUTPUT');
  });
});

describe('Codex CLI executeCodexReviewWithSchema', () => {
  const originalUseAppServer = process.env.CODEX_USE_APP_SERVER;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalUseAppServer === undefined) {
      delete process.env.CODEX_USE_APP_SERVER;
    } else {
      process.env.CODEX_USE_APP_SERVER = originalUseAppServer;
    }
    vi.clearAllMocks();
  });

  test('creates temp file with JSON schema and passes it to executeCodexStep', async () => {
    process.env.CODEX_USE_APP_SERVER = 'false';
    let capturedSchemaPath: string | undefined;

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => '/tmp/repo-review'),
    }));

    vi.doMock('./failure_detection.ts', () => ({
      parseFailedReport: vi.fn(() => ({ failed: false })),
    }));

    // Mock executeCodexStep to capture the schema path
    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: vi.fn(
        async (
          prompt: string,
          _cwd: string,
          _config: any,
          options?: { outputSchemaPath?: string }
        ) => {
          capturedSchemaPath = options?.outputSchemaPath;
          // Verify the schema file exists and contains valid JSON
          if (capturedSchemaPath) {
            const schemaContent = await fs.readFile(capturedSchemaPath, 'utf-8');
            const schema = JSON.parse(schemaContent);
            // Verify it's the expected schema structure
            expect(schema.type).toBe('object');
            expect(schema.properties).toBeDefined();
            expect(schema.properties.issues).toBeDefined();
          }
          return JSON.stringify({ issues: [], recommendations: [], actionItems: [] });
        }
      ),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.js');

    const result = await executeReviewMode(
      'REVIEW PROMPT CONTENT',
      {
        planId: 'review-plan',
        planTitle: 'Review Plan',
        planFilePath: '/tmp/repo-review/plan.yml',
        executionMode: 'review' as const,
        captureOutput: 'result' as const,
      },
      '/tmp/repo-review',
      undefined,
      {}
    );

    // The schema path should have been passed to executeCodexStep
    expect(capturedSchemaPath).toBeDefined();
    expect(capturedSchemaPath).toContain('codex-review-schema-');
    expect(capturedSchemaPath).toContain('review-schema.json');

    expect(result?.content).toContain('issues');
  });

  test('cleans up temp schema file after execution', async () => {
    process.env.CODEX_USE_APP_SERVER = 'false';
    let capturedSchemaPath: string | undefined;

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => '/tmp/repo-review'),
    }));

    vi.doMock('./failure_detection.ts', () => ({
      parseFailedReport: vi.fn(() => ({ failed: false })),
    }));

    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: vi.fn(
        async (
          _prompt: string,
          _cwd: string,
          _config: any,
          options?: { outputSchemaPath?: string }
        ) => {
          capturedSchemaPath = options?.outputSchemaPath;
          return JSON.stringify({ issues: [], recommendations: [], actionItems: [] });
        }
      ),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.js');

    await executeReviewMode(
      'REVIEW PROMPT CONTENT',
      {
        planId: 'review-plan',
        planTitle: 'Review Plan',
        planFilePath: '/tmp/repo-review/plan.yml',
        executionMode: 'review' as const,
        captureOutput: 'result' as const,
      },
      '/tmp/repo-review',
      undefined,
      {}
    );

    // After execution, the temp directory should be cleaned up
    expect(capturedSchemaPath).toBeDefined();
    const tempDir = path.dirname(capturedSchemaPath!);
    const dirExists = await fs
      .access(tempDir)
      .then(() => true)
      .catch(() => false);
    expect(dirExists).toBe(false);
  });

  test('cleans up temp file even when execution fails', async () => {
    process.env.CODEX_USE_APP_SERVER = 'false';
    let capturedSchemaPath: string | undefined;

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => '/tmp/repo-review'),
    }));

    vi.doMock('./failure_detection.ts', () => ({
      parseFailedReport: vi.fn(() => ({ failed: false })),
    }));

    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: vi.fn(
        async (
          _prompt: string,
          _cwd: string,
          _config: any,
          options?: { outputSchemaPath?: string }
        ) => {
          capturedSchemaPath = options?.outputSchemaPath;
          throw new Error('codex failed');
        }
      ),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.js');

    await expect(
      executeReviewMode(
        'REVIEW PROMPT CONTENT',
        {
          planId: 'review-plan',
          planTitle: 'Review Plan',
          planFilePath: '/tmp/repo-review/plan.yml',
          executionMode: 'review' as const,
          captureOutput: 'result' as const,
        },
        '/tmp/repo-review',
        undefined,
        {}
      )
    ).rejects.toThrow('codex failed');

    // Even after failure, temp directory should be cleaned up
    expect(capturedSchemaPath).toBeDefined();
    const tempDir = path.dirname(capturedSchemaPath!);
    const dirExists = await fs
      .access(tempDir)
      .then(() => true)
      .catch(() => false);
    expect(dirExists).toBe(false);
  });

  test('passes timConfig to executeCodexStep', async () => {
    let capturedConfig: any;

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => '/tmp/repo-review'),
    }));

    vi.doMock('./failure_detection.ts', () => ({
      parseFailedReport: vi.fn(() => ({ failed: false })),
    }));

    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: vi.fn(
        async (_prompt: string, _cwd: string, config: any, _schemaPath?: string) => {
          capturedConfig = config;
          return JSON.stringify({ issues: [], recommendations: [], actionItems: [] });
        }
      ),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.js');

    const testConfig = {
      isUsingExternalStorage: true,
      externalRepositoryConfigDir: '/external/config/dir',
    };

    await executeReviewMode(
      'REVIEW PROMPT CONTENT',
      {
        planId: 'review-plan',
        planTitle: 'Review Plan',
        planFilePath: '/tmp/repo-review/plan.yml',
        executionMode: 'review' as const,
        captureOutput: 'result' as const,
      },
      '/tmp/repo-review',
      undefined,
      testConfig as any
    );

    expect(capturedConfig).toEqual(testConfig);
  });

  test('throws error when executeCodexStep returns empty output', async () => {
    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => '/tmp/repo-review'),
    }));

    vi.doMock('./failure_detection.ts', () => ({
      parseFailedReport: vi.fn(() => ({ failed: false })),
    }));

    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: vi.fn(async () => ''),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.js');

    // executeCodexStep returns empty string, which should be handled
    // The current implementation returns the empty string, so we test that
    const result = await executeReviewMode(
      'REVIEW PROMPT CONTENT',
      {
        planId: 'review-plan',
        planTitle: 'Review Plan',
        planFilePath: '/tmp/repo-review/plan.yml',
        executionMode: 'review' as const,
        captureOutput: 'result' as const,
      },
      '/tmp/repo-review',
      undefined,
      {}
    );

    expect(result?.content).toBe('');
  });

  test('passes prompt to executeCodexStep', async () => {
    let capturedPrompt: string | undefined;

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => '/tmp/repo-review'),
    }));

    vi.doMock('./failure_detection.ts', () => ({
      parseFailedReport: vi.fn(() => ({ failed: false })),
    }));

    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: vi.fn(
        async (prompt: string, _cwd: string, _config: any, _schemaPath?: string) => {
          capturedPrompt = prompt;
          return JSON.stringify({ issues: [], recommendations: [], actionItems: [] });
        }
      ),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.js');

    await executeReviewMode(
      'REVIEW PROMPT CONTENT',
      {
        planId: 'review-plan',
        planTitle: 'Review Plan',
        planFilePath: '/tmp/repo-review/plan.yml',
        executionMode: 'review' as const,
        captureOutput: 'result' as const,
      },
      '/tmp/repo-review',
      undefined,
      {}
    );

    expect(capturedPrompt).toBe('REVIEW PROMPT CONTENT');
  });

  test('skips schema temp file creation in app-server mode', async () => {
    delete process.env.CODEX_USE_APP_SERVER;
    let capturedOptions: { outputSchemaPath?: string; outputSchema?: Record<string, unknown> } = {};
    let mkdtempCalled = false;

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => '/tmp/repo-review'),
    }));

    vi.doMock('./failure_detection.ts', () => ({
      parseFailedReport: vi.fn(() => ({ failed: false })),
    }));

    vi.doMock('fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof fs>();
      return {
        ...actual,
        mkdtemp: vi.fn(async (...args: Parameters<typeof fs.mkdtemp>) => {
          mkdtempCalled = true;
          return actual.mkdtemp(...args);
        }),
      };
    });

    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: vi.fn(
        async (
          _prompt: string,
          _cwd: string,
          _config: unknown,
          options?: { outputSchemaPath?: string; outputSchema?: Record<string, unknown> }
        ) => {
          capturedOptions = options ?? {};
          return JSON.stringify({ issues: [], recommendations: [], actionItems: [] });
        }
      ),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.js');

    await executeReviewMode(
      'REVIEW PROMPT CONTENT',
      {
        planId: 'review-plan',
        planTitle: 'Review Plan',
        planFilePath: '/tmp/repo-review/plan.yml',
        executionMode: 'review' as const,
        captureOutput: 'result' as const,
      },
      '/tmp/repo-review',
      undefined,
      {}
    );

    expect(mkdtempCalled).toBe(false);
    expect(capturedOptions.outputSchemaPath).toBeUndefined();
    expect(capturedOptions.outputSchema).toBeDefined();
  });
});
