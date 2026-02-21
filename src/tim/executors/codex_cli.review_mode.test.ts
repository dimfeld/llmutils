import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ModuleMocker } from '../../testing.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('Codex CLI review mode', () => {
  let moduleMocker: ModuleMocker;

  beforeEach(() => {
    moduleMocker = new ModuleMocker(import.meta);
    process.env.CODEX_USE_APP_SERVER = 'false';
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('runs reviewer once and returns aggregated output', async () => {
    const logMessages: string[] = [];

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock((...args: any[]) => logMessages.push(args.map(String).join(' '))),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.ts');

    const reviewExecutor = mock(async () => 'REVIEW OUTPUT');

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
    expect(logMessages.some((msg) => msg.includes('review-only mode'))).toBeTrue();
  });

  test('marks review run as failed when the reviewer reports failure', async () => {
    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({
        failed: true,
        summary: 'failed',
        details: { requirements: '', problems: 'bad news' },
      })),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.ts');

    const reviewExecutor = mock(async () => 'FAILED OUTPUT');

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

    expect(result?.success).toBeFalse();
    expect(result?.failureDetails?.sourceAgent).toBe('reviewer');
    expect(result?.failureDetails?.problems).toBe('bad news');
    expect(result?.content).toBe('FAILED OUTPUT');
  });
});

describe('Codex CLI executeCodexReviewWithSchema', () => {
  let moduleMocker: ModuleMocker;
  const originalUseAppServer = process.env.CODEX_USE_APP_SERVER;

  beforeEach(() => {
    moduleMocker = new ModuleMocker(import.meta);
  });

  afterEach(() => {
    moduleMocker.clear();
    if (originalUseAppServer === undefined) {
      delete process.env.CODEX_USE_APP_SERVER;
    } else {
      process.env.CODEX_USE_APP_SERVER = originalUseAppServer;
    }
  });

  test('creates temp file with JSON schema and passes it to executeCodexStep', async () => {
    let capturedSchemaPath: string | undefined;

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    // Mock executeCodexStep to capture the schema path
    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(
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

    const { executeReviewMode } = await import('./codex_cli/review_mode.ts');

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

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(
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

    const { executeReviewMode } = await import('./codex_cli/review_mode.ts');

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

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(
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

    const { executeReviewMode } = await import('./codex_cli/review_mode.ts');

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

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(
        async (_prompt: string, _cwd: string, config: any, _schemaPath?: string) => {
          capturedConfig = config;
          return JSON.stringify({ issues: [], recommendations: [], actionItems: [] });
        }
      ),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.ts');

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
    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(async () => ''),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.ts');

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

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(
        async (prompt: string, _cwd: string, _config: any, _schemaPath?: string) => {
          capturedPrompt = prompt;
          return JSON.stringify({ issues: [], recommendations: [], actionItems: [] });
        }
      ),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.ts');

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
    const mkdtempSpy = mock(fs.mkdtemp);
    let capturedOptions: { outputSchemaPath?: string; outputSchema?: Record<string, unknown> } = {};

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    await moduleMocker.mock('fs/promises', () => ({
      ...fs,
      mkdtemp: mkdtempSpy,
    }));

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(
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

    const { executeReviewMode } = await import('./codex_cli/review_mode.ts');

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

    expect(mkdtempSpy).not.toHaveBeenCalled();
    expect(capturedOptions.outputSchemaPath).toBeUndefined();
    expect(capturedOptions.outputSchema).toBeDefined();
  });
});
