import { test, describe, expect, mock } from 'bun:test';
import { z } from 'zod/v4';
import { createExecutor, executors } from './build.ts';
import type { TimConfig } from '../configSchema.ts';
import type { ExecutorCommonOptions, ExecutorFactory, Executor } from './types.ts';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('createExecutor', () => {
  // Mock executor options schema
  const mockOptionsSchema = z.object({
    testOption: z.string().default('default'),
    numberOption: z.number().default(42),
    simpleMode: z.boolean().optional(),
  });

  // Mock executor class
  class MockExecutor implements Executor {
    static name = 'MockExecutor';
    static optionsSchema = mockOptionsSchema;

    constructor(
      public options: z.infer<typeof mockOptionsSchema>,
      public sharedOptions: ExecutorCommonOptions,
      public config: TimConfig
    ) {}

    async execute() {
      return { success: true };
    }
  }

  // Mock shared options
  const mockSharedOptions: ExecutorCommonOptions = {
    baseDir: '/test/workspace',
    model: 'test-model',
    interactive: false,
  };

  test('creates executor with options from config when no options provided', () => {
    // Set up the mock executor in the executors map
    executors.set('MockExecutor', MockExecutor as any);

    const mockConfig: TimConfig = {
      defaultExecutor: 'MockExecutor',
      executors: {
        MockExecutor: {
          testOption: 'from-config',
          numberOption: 100,
        },
      },
    };

    const result = createExecutor('MockExecutor', {}, mockSharedOptions, mockConfig);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.factory).toBe(MockExecutor);
      expect(result.executor).toBeInstanceOf(MockExecutor);
      const mockExecutorInstance = result.executor as MockExecutor;
      expect(mockExecutorInstance.options).toEqual({
        testOption: 'from-config',
        numberOption: 100,
      });
      expect(mockExecutorInstance.sharedOptions).toBe(mockSharedOptions);
      expect(mockExecutorInstance.config).toBe(mockConfig);
    }

    // Clean up
    executors.delete('MockExecutor');
  });

  test('merges config options with provided options (provided options take precedence)', () => {
    executors.set('MockExecutor', MockExecutor as any);

    const mockConfig: TimConfig = {
      defaultExecutor: 'MockExecutor',
      executors: {
        MockExecutor: {
          testOption: 'from-config',
          numberOption: 100,
        },
      },
    };

    const providedOptions = {
      testOption: 'from-cli',
    };

    const result = createExecutor('MockExecutor', providedOptions, mockSharedOptions, mockConfig);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      const mockExecutorInstance = result.executor as MockExecutor;
      expect(mockExecutorInstance.options).toEqual({
        testOption: 'from-cli', // CLI option takes precedence
        numberOption: 100, // Config option is used
      });
    }

    executors.delete('MockExecutor');
  });

  test('uses default values when no options in config or provided', () => {
    executors.set('MockExecutor', MockExecutor as any);

    const mockConfig: TimConfig = {
      defaultExecutor: 'MockExecutor',
      // No executors section
    };

    const result = createExecutor('MockExecutor', {}, mockSharedOptions, mockConfig);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      const mockExecutorInstance = result.executor as MockExecutor;
      expect(mockExecutorInstance.options).toEqual({
        testOption: 'default',
        numberOption: 42,
      });
    }

    executors.delete('MockExecutor');
  });

  test('returns error when executor not found', () => {
    const mockConfig: TimConfig = {
      defaultExecutor: 'MockExecutor',
    };

    const result = createExecutor('NonExistentExecutor', {}, mockSharedOptions, mockConfig);

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('Executor "NonExistentExecutor" not found.');
    }
  });

  test('returns error when options validation fails', () => {
    // Create executor with strict schema
    const strictSchema = z.object({
      requiredOption: z.string(),
    });

    class StrictExecutor implements Executor {
      static name = 'StrictExecutor';
      static optionsSchema = strictSchema;

      constructor(
        public options: z.infer<typeof strictSchema>,
        public sharedOptions: ExecutorCommonOptions,
        public config: TimConfig
      ) {}

      async execute() {
        return { success: true };
      }
    }

    executors.set('StrictExecutor', StrictExecutor as any);

    const mockConfig: TimConfig = {
      defaultExecutor: 'StrictExecutor',
      executors: {
        StrictExecutor: {
          // Missing requiredOption
        },
      },
    };

    const result = createExecutor('StrictExecutor', {}, mockSharedOptions, mockConfig);

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('options schema that could not be satisfied');
      expect(result.errorDetails).toBeDefined();
    }

    executors.delete('StrictExecutor');
  });

  test('creates claude-code executor with autoApproveCreatedFileDeletion property', () => {
    const mockConfig: TimConfig = {
      defaultExecutor: 'claude-code',
      executors: {
        'claude-code': {
          allowedTools: ['Write', 'Edit', 'Bash'],
          permissionsMcp: { enabled: true, autoApproveCreatedFileDeletion: true },
        },
      },
    };

    const result = createExecutor('claude-code', {}, mockSharedOptions, mockConfig);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.factory.name).toBe('claude-code');
      expect(result.executor).toBeDefined();
      // Verify the options include the autoApproveCreatedFileDeletion property
      const options = (result.executor as any).options;
      expect(options.allowedTools).toEqual(['Write', 'Edit', 'Bash']);
      expect(options.permissionsMcp?.enabled).toBe(true);
      expect(options.permissionsMcp?.autoApproveCreatedFileDeletion).toBe(true);
    }
  });

  test('creates claude-code executor with default autoApproveCreatedFileDeletion (undefined)', () => {
    const mockConfig: TimConfig = {
      defaultExecutor: 'claude-code',
      executors: {
        'claude-code': {
          allowedTools: ['Write'],
        },
      },
    };

    const result = createExecutor('claude-code', {}, mockSharedOptions, mockConfig);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      const options = (result.executor as any).options;
      expect(options.permissionsMcp?.autoApproveCreatedFileDeletion).toBeUndefined();
      expect(options.allowedTools).toEqual(['Write']);
    }
  });

  test('claude-code executor CLI options override config for autoApproveCreatedFileDeletion', () => {
    const mockConfig: TimConfig = {
      defaultExecutor: 'claude-code',
      executors: {
        'claude-code': {
          permissionsMcp: {
            enabled: true,
            autoApproveCreatedFileDeletion: false,
          },
        },
      },
    };

    const cliOptions = {
      permissionsMcp: {
        enabled: true,
        autoApproveCreatedFileDeletion: true,
      },
    };

    const result = createExecutor('claude-code', cliOptions, mockSharedOptions, mockConfig);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      const options = (result.executor as any).options;
      expect(options.permissionsMcp?.autoApproveCreatedFileDeletion).toBe(true); // CLI option takes precedence
    }
  });
  test('prefers CLI-provided simpleMode over config value', () => {
    executors.set('MockExecutor', MockExecutor as any);

    const mockConfig: TimConfig = {
      defaultExecutor: 'MockExecutor',
      executors: {
        MockExecutor: {
          testOption: 'from-config',
          numberOption: 7,
          simpleMode: false,
        },
      },
    };

    const cliOptions = {
      simpleMode: true,
    };

    const result = createExecutor('MockExecutor', cliOptions, mockSharedOptions, mockConfig);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      const mockExecutorInstance = result.executor as MockExecutor;
      expect(mockExecutorInstance.options).toEqual({
        testOption: 'from-config',
        numberOption: 7,
        simpleMode: true,
      });
    }

    executors.delete('MockExecutor');
  });
});
