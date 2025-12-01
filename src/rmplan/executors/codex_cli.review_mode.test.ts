import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ModuleMocker } from '../../testing.js';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Codex CLI review mode', () => {
  let moduleMocker: ModuleMocker;

  beforeEach(() => {
    moduleMocker = new ModuleMocker(import.meta);
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

    expect(reviewExecutor).toHaveBeenCalledWith('REVIEW PROMPT CONTENT', '/tmp/repo-review', {});
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

  beforeEach(() => {
    moduleMocker = new ModuleMocker(import.meta);
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('creates temp file with JSON schema and passes --output-schema flag', async () => {
    const recordedArgs: string[][] = [];
    let capturedSchemaPath: string | undefined;

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (args: string[]) => {
        recordedArgs.push(args);
        // Find the schema file path from the args
        const schemaIndex = args.indexOf('--output-schema');
        if (schemaIndex !== -1) {
          capturedSchemaPath = args[schemaIndex + 1];
          // Verify the schema file exists and contains valid JSON
          try {
            const schemaContent = await fs.readFile(capturedSchemaPath, 'utf-8');
            const schema = JSON.parse(schemaContent);
            // Verify it's the expected schema structure
            expect(schema.type).toBe('object');
            expect(schema.properties).toBeDefined();
            expect(schema.properties.issues).toBeDefined();
          } catch (err) {
            throw new Error(`Schema file not valid: ${err}`);
          }
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
        };
      }),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.ts');

    // Don't provide reviewExecutor to use the default executeCodexReviewWithSchema
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

    expect(recordedArgs).toHaveLength(1);
    const args = recordedArgs[0];

    // Verify --output-schema is in the args
    expect(args).toContain('--output-schema');

    // The schema path should have been in a temp directory
    expect(capturedSchemaPath).toBeDefined();
    expect(capturedSchemaPath).toContain('codex-review-schema-');
    expect(capturedSchemaPath).toContain('review-schema.json');

    expect(result?.content).toContain('issues');
  });

  test('cleans up temp schema file after execution', async () => {
    let capturedSchemaPath: string | undefined;
    let capturedTempDir: string | undefined;

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (args: string[]) => {
        const schemaIndex = args.indexOf('--output-schema');
        if (schemaIndex !== -1) {
          capturedSchemaPath = args[schemaIndex + 1];
          capturedTempDir = path.dirname(capturedSchemaPath);
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
        };
      }),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
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
    expect(capturedTempDir).toBeDefined();
    const dirExists = await fs
      .access(capturedTempDir!)
      .then(() => true)
      .catch(() => false);
    expect(dirExists).toBe(false);
  });

  test('cleans up temp file even when execution fails', async () => {
    let capturedTempDir: string | undefined;

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (args: string[]) => {
        const schemaIndex = args.indexOf('--output-schema');
        if (schemaIndex !== -1) {
          capturedTempDir = path.dirname(args[schemaIndex + 1]);
        }
        return {
          exitCode: 1, // Simulate failure
          stdout: '',
        };
      }),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
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
    expect(capturedTempDir).toBeDefined();
    const dirExists = await fs
      .access(capturedTempDir!)
      .then(() => true)
      .catch(() => false);
    expect(dirExists).toBe(false);
  });

  test('uses sandbox settings based on ALLOW_ALL_TOOLS env', async () => {
    const recordedArgs: string[][] = [];
    const originalEnv = process.env.ALLOW_ALL_TOOLS;

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (args: string[]) => {
        recordedArgs.push(args);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
        };
      }),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    try {
      // Test with ALLOW_ALL_TOOLS=false (default sandbox)
      process.env.ALLOW_ALL_TOOLS = 'false';
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

      expect(recordedArgs).toHaveLength(1);
      const args = recordedArgs[0];
      expect(args).toContain('--sandbox');
      expect(args).toContain('workspace-write');
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.ALLOW_ALL_TOOLS;
      } else {
        process.env.ALLOW_ALL_TOOLS = originalEnv;
      }
    }
  });

  test('adds writable_roots for external storage configuration', async () => {
    const recordedArgs: string[][] = [];

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (args: string[]) => {
        recordedArgs.push(args);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
        };
      }),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
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
      {
        isUsingExternalStorage: true,
        externalRepositoryConfigDir: '/external/config/dir',
      } as any
    );

    expect(recordedArgs).toHaveLength(1);
    const args = recordedArgs[0];

    // Find the writable_roots config
    const configIndex = args.findIndex((arg) => arg.includes('writable_roots'));
    expect(configIndex).toBeGreaterThan(-1);
    expect(args[configIndex]).toContain('/external/config/dir');
  });

  test('throws error when Codex returns empty output', async () => {
    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async () => ({
        exitCode: 0,
        stdout: '', // Empty output
      })),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
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
    ).rejects.toThrow('Codex review returned empty output');
  });

  test('includes codex exec command with expected flags', async () => {
    const recordedArgs: string[][] = [];

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (args: string[]) => {
        recordedArgs.push(args);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
        };
      }),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
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

    expect(recordedArgs).toHaveLength(1);
    const args = recordedArgs[0];

    // Verify codex exec command structure
    expect(args[0]).toBe('codex');
    expect(args).toContain('exec');
    expect(args).toContain('--enable');
    expect(args).toContain('web_search_request');
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort=high');

    // Verify the prompt is the last argument
    expect(args[args.length - 1]).toBe('REVIEW PROMPT CONTENT');
  });
});
