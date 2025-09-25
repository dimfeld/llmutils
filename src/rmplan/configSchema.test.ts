import { test, describe, expect } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { rmplanConfigSchema, getDefaultConfig, resolveTasksDir } from './configSchema.js';

describe('configSchema', () => {
  describe('issueTracker field', () => {
    test('should accept "github" value', () => {
      const config = {
        issueTracker: 'github' as const,
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.issueTracker).toBe('github');
    });

    test('should accept "linear" value', () => {
      const config = {
        issueTracker: 'linear' as const,
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.issueTracker).toBe('linear');
    });

    test('should be undefined when not specified', () => {
      const config = {};

      const result = rmplanConfigSchema.parse(config);
      expect(result.issueTracker).toBeUndefined();
    });

    test('should reject invalid values', () => {
      const config = {
        issueTracker: 'invalid',
      };

      expect(() => rmplanConfigSchema.parse(config)).toThrow();
    });

    test('should reject non-string values', () => {
      const config = {
        issueTracker: 123,
      };

      expect(() => rmplanConfigSchema.parse(config)).toThrow();
    });

    test('should reject null value', () => {
      const config = {
        issueTracker: null,
      };

      expect(() => rmplanConfigSchema.parse(config)).toThrow();
    });
  });

  describe('getDefaultConfig', () => {
    test('should include issueTracker with default value "github"', () => {
      const defaultConfig = getDefaultConfig();

      expect(defaultConfig).toHaveProperty('issueTracker');
      expect(defaultConfig.issueTracker).toBe('github');
    });

    test('should include prCreation with default draft value true', () => {
      const defaultConfig = getDefaultConfig();

      expect(defaultConfig).toHaveProperty('prCreation');
      expect(defaultConfig.prCreation).toEqual({ draft: true });
    });

    test('should return a valid configuration according to schema', () => {
      const defaultConfig = getDefaultConfig();

      // Should not throw when validating against schema
      expect(() => rmplanConfigSchema.parse(defaultConfig)).not.toThrow();

      const validatedConfig = rmplanConfigSchema.parse(defaultConfig);
      expect(validatedConfig.issueTracker).toBe('github');
      expect(validatedConfig.prCreation?.draft).toBe(true);
    });
  });

  describe('schema validation with issueTracker and other fields', () => {
    test('should validate complete config with issueTracker', () => {
      const config = {
        issueTracker: 'linear' as const,
        postApplyCommands: [
          {
            title: 'Test Command',
            command: 'echo test',
          },
        ],
        defaultExecutor: 'claude-code',
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.issueTracker).toBe('linear');
      expect(result.postApplyCommands).toHaveLength(1);
      expect(result.defaultExecutor).toBe('claude-code');
    });

    test('should validate issueTracker with case sensitivity', () => {
      const invalidConfig = {
        issueTracker: 'GitHub', // Wrong case
      };

      expect(() => rmplanConfigSchema.parse(invalidConfig)).toThrow();
    });

    test('should validate issueTracker with empty string', () => {
      const invalidConfig = {
        issueTracker: '',
      };

      expect(() => rmplanConfigSchema.parse(invalidConfig)).toThrow();
    });

    test('should validate issueTracker with undefined explicitly set', () => {
      const config = {
        issueTracker: undefined,
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.issueTracker).toBeUndefined();
    });
  });

  describe('prCreation field', () => {
    test('should accept valid prCreation configuration with all fields', () => {
      const config = {
        prCreation: {
          draft: false,
          titlePrefix: '[Feature] ',
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.prCreation?.draft).toBe(false);
      expect(result.prCreation?.titlePrefix).toBe('[Feature] ');
    });

    test('should accept partial prCreation configuration with only draft', () => {
      const config = {
        prCreation: {
          draft: true,
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.prCreation?.draft).toBe(true);
      expect(result.prCreation?.titlePrefix).toBeUndefined();
    });

    test('should accept partial prCreation configuration with only titlePrefix', () => {
      const config = {
        prCreation: {
          titlePrefix: '[WIP] ',
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.prCreation?.draft).toBe(true); // Should use default
      expect(result.prCreation?.titlePrefix).toBe('[WIP] ');
    });

    test('should make prCreation field optional', () => {
      const config = {
        issueTracker: 'github' as const,
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.prCreation).toBeUndefined();
    });

    test('should default draft to true when not specified in config', () => {
      const config = {
        prCreation: {
          titlePrefix: 'Test: ',
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.prCreation?.draft).toBe(true);
    });

    test('should default draft to true when prCreation exists but draft is undefined', () => {
      const config = {
        prCreation: {
          draft: undefined,
          titlePrefix: 'Test: ',
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.prCreation?.draft).toBe(true);
    });

    test('should preserve explicitly set draft false value', () => {
      const config = {
        prCreation: {
          draft: false,
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.prCreation?.draft).toBe(false);
    });

    test('should reject non-boolean values for draft', () => {
      const invalidConfigs = [
        {
          prCreation: {
            draft: 'true',
          },
        },
        {
          prCreation: {
            draft: 1,
          },
        },
        {
          prCreation: {
            draft: null,
          },
        },
      ];

      for (const invalidConfig of invalidConfigs) {
        expect(() => rmplanConfigSchema.parse(invalidConfig)).toThrow();
      }
    });

    test('should reject non-string values for titlePrefix', () => {
      const invalidConfigs = [
        {
          prCreation: {
            titlePrefix: 123,
          },
        },
        {
          prCreation: {
            titlePrefix: true,
          },
        },
        {
          prCreation: {
            titlePrefix: null,
          },
        },
      ];

      for (const invalidConfig of invalidConfigs) {
        expect(() => rmplanConfigSchema.parse(invalidConfig)).toThrow();
      }
    });

    test('should accept empty titlePrefix string', () => {
      const config = {
        prCreation: {
          titlePrefix: '',
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.prCreation?.titlePrefix).toBe('');
      expect(result.prCreation?.draft).toBe(true); // Should use default
    });

    test('should accept titlePrefix with special characters', () => {
      const config = {
        prCreation: {
          titlePrefix: '[🚀] Feature: ',
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.prCreation?.titlePrefix).toBe('[🚀] Feature: ');
    });

    test('should accept empty prCreation object', () => {
      const config = {
        prCreation: {},
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.prCreation).toBeDefined();
      expect(result.prCreation?.draft).toBe(true); // Should use default
      expect(result.prCreation?.titlePrefix).toBeUndefined();
    });

    test('should reject unknown fields within prCreation due to strict', () => {
      const config = {
        prCreation: {
          draft: true,
          titlePrefix: 'Test: ',
          unknownField: 'invalid',
        },
      };

      expect(() => rmplanConfigSchema.parse(config)).toThrow();
    });

    test('should work correctly alongside other configuration fields', () => {
      const config = {
        issueTracker: 'linear' as const,
        defaultExecutor: 'claude-code',
        prCreation: {
          draft: false,
          titlePrefix: '[Feature] ',
        },
        review: {
          focusAreas: ['security'],
          outputFormat: 'json' as const,
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.issueTracker).toBe('linear');
      expect(result.defaultExecutor).toBe('claude-code');
      expect(result.prCreation?.draft).toBe(false);
      expect(result.prCreation?.titlePrefix).toBe('[Feature] ');
      expect(result.review?.focusAreas).toEqual(['security']);
      expect(result.review?.outputFormat).toBe('json');
    });
  });

  describe('agents field', () => {
    test('should accept valid agent configurations with all three agents', () => {
      const config = {
        agents: {
          implementer: { instructions: './instructions/implementer.md' },
          tester: { instructions: './instructions/tester.md' },
          reviewer: { instructions: './instructions/reviewer.md' },
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.agents?.implementer?.instructions).toBe('./instructions/implementer.md');
      expect(result.agents?.tester?.instructions).toBe('./instructions/tester.md');
      expect(result.agents?.reviewer?.instructions).toBe('./instructions/reviewer.md');
    });

    test('should accept partial configurations with only some agents', () => {
      const config = {
        agents: {
          implementer: { instructions: './implementer.md' },
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.agents?.implementer?.instructions).toBe('./implementer.md');
      expect(result.agents?.tester).toBeUndefined();
      expect(result.agents?.reviewer).toBeUndefined();
    });

    test('should accept agents with missing instructions field', () => {
      const config = {
        agents: {
          implementer: {},
          tester: { instructions: './tester.md' },
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.agents?.implementer?.instructions).toBeUndefined();
      expect(result.agents?.tester?.instructions).toBe('./tester.md');
    });

    test('should reject invalid field names within agents', () => {
      const config = {
        agents: {
          invalid_agent: { instructions: './test.md' },
        },
      };

      expect(() => rmplanConfigSchema.parse(config)).toThrow();
    });

    test('should ensure the field is optional', () => {
      const config = {
        issueTracker: 'github' as const,
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.agents).toBeUndefined();
    });

    test('should reject non-string instructions values', () => {
      const config = {
        agents: {
          implementer: { instructions: 123 },
        },
      };

      expect(() => rmplanConfigSchema.parse(config)).toThrow();
    });

    test('should accept empty agents object', () => {
      const config = {
        agents: {},
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.agents).toBeDefined();
      expect(Object.keys(result.agents)).toHaveLength(0);
    });

    test('should work with other configuration fields', () => {
      const config = {
        issueTracker: 'linear' as const,
        defaultExecutor: 'claude-code',
        agents: {
          implementer: { instructions: './implementer.md' },
          reviewer: { instructions: './reviewer.md' },
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.issueTracker).toBe('linear');
      expect(result.defaultExecutor).toBe('claude-code');
      expect(result.agents?.implementer?.instructions).toBe('./implementer.md');
      expect(result.agents?.reviewer?.instructions).toBe('./reviewer.md');
    });
  });

  describe('review field', () => {
    test('should accept valid review configuration with all fields', () => {
      const config = {
        review: {
          focusAreas: ['security', 'performance', 'testing'],
          outputFormat: 'markdown' as const,
          saveLocation: './reviews',
          customInstructionsPath: './review-instructions.md',
          incrementalReview: true,
          excludePatterns: ['*.test.ts', 'node_modules/**'],
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.review?.focusAreas).toEqual(['security', 'performance', 'testing']);
      expect(result.review?.outputFormat).toBe('markdown');
      expect(result.review?.saveLocation).toBe('./reviews');
      expect(result.review?.customInstructionsPath).toBe('./review-instructions.md');
      expect(result.review?.incrementalReview).toBe(true);
      expect(result.review?.excludePatterns).toEqual(['*.test.ts', 'node_modules/**']);
    });

    test('should accept partial review configuration', () => {
      const config = {
        review: {
          focusAreas: ['security'],
          outputFormat: 'json' as const,
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.review?.focusAreas).toEqual(['security']);
      expect(result.review?.outputFormat).toBe('json');
      expect(result.review?.saveLocation).toBeUndefined();
      expect(result.review?.customInstructionsPath).toBeUndefined();
      expect(result.review?.incrementalReview).toBeUndefined();
      expect(result.review?.excludePatterns).toBeUndefined();
    });

    test('should accept empty review configuration', () => {
      const config = {
        review: {},
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.review).toBeDefined();
      expect(Object.keys(result.review)).toHaveLength(0);
    });

    test('should make review field optional', () => {
      const config = {
        issueTracker: 'github' as const,
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.review).toBeUndefined();
    });

    test('should validate outputFormat enum values', () => {
      const validFormats = ['json', 'markdown', 'terminal'];

      for (const format of validFormats) {
        const config = {
          review: {
            outputFormat: format,
          },
        };

        expect(() => rmplanConfigSchema.parse(config)).not.toThrow();
        const result = rmplanConfigSchema.parse(config);
        expect(result.review?.outputFormat).toBe(format);
      }

      // Test invalid format
      const invalidConfig = {
        review: {
          outputFormat: 'invalid',
        },
      };

      expect(() => rmplanConfigSchema.parse(invalidConfig)).toThrow();
    });

    test('should validate focusAreas as array of strings', () => {
      const config = {
        review: {
          focusAreas: ['security', 'performance'],
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.review?.focusAreas).toEqual(['security', 'performance']);

      // Test invalid focusAreas type
      const invalidConfig = {
        review: {
          focusAreas: 'security',
        },
      };

      expect(() => rmplanConfigSchema.parse(invalidConfig)).toThrow();
    });

    test('should validate file paths as strings', () => {
      const config = {
        review: {
          saveLocation: '/path/to/reviews',
          customInstructionsPath: '/path/to/instructions.md',
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.review?.saveLocation).toBe('/path/to/reviews');
      expect(result.review?.customInstructionsPath).toBe('/path/to/instructions.md');

      // Test invalid path types
      const invalidConfigs = [
        {
          review: {
            saveLocation: 123,
          },
        },
        {
          review: {
            customInstructionsPath: true,
          },
        },
      ];

      for (const invalidConfig of invalidConfigs) {
        expect(() => rmplanConfigSchema.parse(invalidConfig)).toThrow();
      }
    });

    test('should validate incrementalReview as boolean', () => {
      const configTrue = {
        review: {
          incrementalReview: true,
        },
      };

      const configFalse = {
        review: {
          incrementalReview: false,
        },
      };

      expect(() => rmplanConfigSchema.parse(configTrue)).not.toThrow();
      expect(() => rmplanConfigSchema.parse(configFalse)).not.toThrow();

      const resultTrue = rmplanConfigSchema.parse(configTrue);
      const resultFalse = rmplanConfigSchema.parse(configFalse);

      expect(resultTrue.review?.incrementalReview).toBe(true);
      expect(resultFalse.review?.incrementalReview).toBe(false);

      // Test invalid type
      const invalidConfig = {
        review: {
          incrementalReview: 'true',
        },
      };

      expect(() => rmplanConfigSchema.parse(invalidConfig)).toThrow();
    });

    test('should validate excludePatterns as array of strings', () => {
      const config = {
        review: {
          excludePatterns: ['*.test.ts', '**/*.spec.js', 'node_modules/**'],
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.review?.excludePatterns).toEqual([
        '*.test.ts',
        '**/*.spec.js',
        'node_modules/**',
      ]);

      // Test invalid excludePatterns types
      const invalidConfigs = [
        {
          review: {
            excludePatterns: '*.test.ts',
          },
        },
        {
          review: {
            excludePatterns: [123, '*.test.ts'],
          },
        },
      ];

      for (const invalidConfig of invalidConfigs) {
        expect(() => rmplanConfigSchema.parse(invalidConfig)).toThrow();
      }
    });

    test('should work with other configuration fields', () => {
      const config = {
        issueTracker: 'linear' as const,
        defaultExecutor: 'claude-code',
        review: {
          focusAreas: ['security'],
          outputFormat: 'terminal' as const,
          incrementalReview: true,
        },
        agents: {
          implementer: { instructions: './implementer.md' },
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.issueTracker).toBe('linear');
      expect(result.defaultExecutor).toBe('claude-code');
      expect(result.review?.focusAreas).toEqual(['security']);
      expect(result.review?.outputFormat).toBe('terminal');
      expect(result.review?.incrementalReview).toBe(true);
      expect(result.agents?.implementer?.instructions).toBe('./implementer.md');
    });

    test('should reject unknown fields in review configuration', () => {
      const config = {
        review: {
          focusAreas: ['security'],
          unknownField: 'invalid',
        },
      };

      expect(() => rmplanConfigSchema.parse(config)).toThrow();
    });

    test('should handle empty arrays correctly', () => {
      const config = {
        review: {
          focusAreas: [],
          excludePatterns: [],
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.review?.focusAreas).toEqual([]);
      expect(result.review?.excludePatterns).toEqual([]);
    });
  });

  describe('resolveTasksDir', () => {
    test('uses external repository directory when external storage is active', async () => {
      const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-external-'));
      try {
        const config = {
          ...getDefaultConfig(),
          isUsingExternalStorage: true,
          externalRepositoryConfigDir: externalDir,
        } as const;

        const tasksDir = await resolveTasksDir(config);
        expect(tasksDir).toBe(path.join(externalDir, 'tasks'));
        const stats = await fs.stat(tasksDir);
        expect(stats.isDirectory()).toBe(true);
      } finally {
        await fs.rm(externalDir, { recursive: true, force: true });
      }
    });

    test('resolves relative task paths against external directory when provided', async () => {
      const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-external-rel-'));
      try {
        const config = {
          ...getDefaultConfig(),
          isUsingExternalStorage: true,
          externalRepositoryConfigDir: externalDir,
          paths: {
            tasks: 'plans',
          },
        } as const;

        const tasksDir = await resolveTasksDir(config);
        expect(tasksDir).toBe(path.join(externalDir, 'plans'));
        const stats = await fs.stat(tasksDir);
        expect(stats.isDirectory()).toBe(true);
      } finally {
        await fs.rm(externalDir, { recursive: true, force: true });
      }
    });
  });
});
