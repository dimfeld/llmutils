import { test, describe, expect, vi } from 'vitest';
import { timConfigSchema, getDefaultConfig } from './configSchema.js';

describe('configSchema', () => {
  describe('issueTracker field', () => {
    test('should accept "github" value', () => {
      const config = {
        issueTracker: 'github' as const,
      };

      const result = timConfigSchema.parse(config);
      expect(result.issueTracker).toBe('github');
    });

    test('should accept "linear" value', () => {
      const config = {
        issueTracker: 'linear' as const,
      };

      const result = timConfigSchema.parse(config);
      expect(result.issueTracker).toBe('linear');
    });

    test('should be undefined when not specified', () => {
      const config = {};

      const result = timConfigSchema.parse(config);
      expect(result.issueTracker).toBeUndefined();
    });

    test('should reject invalid values', () => {
      const config = {
        issueTracker: 'invalid',
      };

      expect(() => timConfigSchema.parse(config)).toThrow();
    });

    test('should reject non-string values', () => {
      const config = {
        issueTracker: 123,
      };

      expect(() => timConfigSchema.parse(config)).toThrow();
    });

    test('should reject null value', () => {
      const config = {
        issueTracker: null,
      };

      expect(() => timConfigSchema.parse(config)).toThrow();
    });
  });

  describe('tags configuration', () => {
    test('accepts allowed tags array', () => {
      const config = {
        tags: {
          allowed: ['frontend', 'backend', 'urgent'],
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.tags?.allowed).toEqual(['frontend', 'backend', 'urgent']);
    });

    test('makes tags field optional', () => {
      const result = timConfigSchema.parse({});
      expect(result.tags).toBeUndefined();
    });

    test('rejects non-string entries in allowed list', () => {
      const config = {
        tags: {
          allowed: ['frontend', 123],
        },
      };

      expect(() => timConfigSchema.parse(config)).toThrow();
    });
  });

  describe('headless configuration', () => {
    test('accepts headless url', () => {
      const config = {
        headless: {
          url: 'ws://localhost:8123/tim-agent',
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.headless?.url).toBe('ws://localhost:8123/tim-agent');
    });

    test('makes headless field optional', () => {
      const result = timConfigSchema.parse({});
      expect(result.headless).toBeUndefined();
    });

    test('rejects unknown fields within headless due to strict', () => {
      const config = {
        headless: {
          url: 'ws://localhost:8123/tim-agent',
          unknownField: 'invalid',
        },
      };

      expect(() => timConfigSchema.parse(config)).toThrow();
    });
  });

  describe('sync configuration', () => {
    test('accepts missing sync section', () => {
      const result = timConfigSchema.parse({});
      expect(result.sync).toBeUndefined();
    });

    test('accepts valid sync configs for each role', () => {
      expect(
        timConfigSchema.parse({
          sync: {
            role: 'main',
            nodeId: 'main-node',
            serverHost: '0.0.0.0',
            serverPort: 8124,
            requireSecureTransport: true,
          },
        }).sync?.role
      ).toBe('main');

      expect(
        timConfigSchema.parse({
          sync: {
            role: 'persistent',
            nodeId: 'laptop',
            mainUrl: 'http://localhost:8123',
            nodeTokenEnv: 'TIM_SYNC_TOKEN',
          },
        }).sync?.role
      ).toBe('persistent');

      expect(
        timConfigSchema.parse({
          sync: { role: 'ephemeral', nodeId: 'worker' },
        }).sync?.role
      ).toBe('ephemeral');
    });

    test('rejects nodeToken and nodeTokenEnv together', () => {
      expect(() =>
        timConfigSchema.parse({
          sync: {
            role: 'persistent',
            nodeToken: 'plain',
            nodeTokenEnv: 'TIM_SYNC_TOKEN',
          },
        })
      ).toThrow();
    });

    test('rejects allowedNodes when role is not main', () => {
      expect(() =>
        timConfigSchema.parse({
          sync: {
            role: 'persistent',
            mainUrl: 'http://main.local',
            nodeToken: 'tok',
            allowedNodes: [{ nodeId: 'node-a', tokenHash: 'a'.repeat(64) }],
          },
        })
      ).toThrow();

      expect(() =>
        timConfigSchema.parse({
          sync: {
            role: 'ephemeral',
            allowedNodes: [{ nodeId: 'node-a', tokenHash: 'a'.repeat(64) }],
          },
        })
      ).toThrow();
    });

    test('rejects main-node server bind fields when role is not main', () => {
      expect(() =>
        timConfigSchema.parse({
          sync: {
            role: 'persistent',
            mainUrl: 'http://main.local',
            nodeToken: 'tok',
            serverHost: '0.0.0.0',
          },
        })
      ).toThrow();

      expect(() =>
        timConfigSchema.parse({
          sync: {
            role: 'ephemeral',
            serverPort: 8124,
          },
        })
      ).toThrow();
    });

    test('rejects duplicate nodeId in allowedNodes', () => {
      expect(() =>
        timConfigSchema.parse({
          sync: {
            role: 'main',
            allowedNodes: [
              { nodeId: 'node-a', tokenHash: 'a'.repeat(64) },
              { nodeId: 'node-a', tokenEnv: 'OTHER_TOKEN' },
            ],
          },
        })
      ).toThrow();
    });

    test('rejects allowedNodes entries without exactly one token source', () => {
      expect(() =>
        timConfigSchema.parse({
          sync: {
            role: 'main',
            allowedNodes: [{ nodeId: 'node-a' }],
          },
        })
      ).toThrow();

      expect(() =>
        timConfigSchema.parse({
          sync: {
            role: 'main',
            allowedNodes: [
              {
                nodeId: 'node-a',
                tokenHash: 'a'.repeat(64),
                tokenEnv: 'TIM_NODE_A_TOKEN',
              },
            ],
          },
        })
      ).toThrow();
    });
  });

  describe('lifecycle configuration', () => {
    test('accepts lifecycle commands with onlyWorkspaceType', () => {
      const config = {
        lifecycle: {
          commands: [
            {
              title: 'docker',
              command: 'docker compose up -d',
              shutdown: 'docker compose down',
              onlyWorkspaceType: 'auto' as const,
            },
          ],
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.lifecycle?.commands?.[0]?.onlyWorkspaceType).toBe('auto');
    });

    test('accepts lifecycle commands with runIn contexts', () => {
      const config = {
        lifecycle: {
          commands: [
            {
              title: 'pnpm install',
              command: 'pnpm install',
              runIn: ['agent'],
            },
          ],
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.lifecycle?.commands?.[0]?.runIn).toEqual(['agent']);
    });

    test('accepts review as a lifecycle command context', () => {
      const config = {
        lifecycle: {
          commands: [
            {
              title: 'review prep',
              command: 'pnpm install',
              runIn: ['review'],
            },
          ],
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.lifecycle?.commands?.[0]?.runIn).toEqual(['review']);
    });

    test('rejects invalid runIn contexts', () => {
      expect(() =>
        timConfigSchema.parse({
          lifecycle: {
            commands: [
              {
                title: 'pnpm install',
                command: 'pnpm install',
                runIn: ['invalid'],
              },
            ],
          },
        })
      ).toThrow();
    });
  });

  describe('updateDocs.mode', () => {
    test('accepts all valid modes', () => {
      for (const mode of [
        'never',
        'after-iteration',
        'after-completion',
        'after-review',
        'manual',
      ] as const) {
        const result = timConfigSchema.parse({
          updateDocs: { mode },
        });
        expect(result.updateDocs?.mode).toBe(mode);
      }
    });

    test('rejects invalid mode values', () => {
      expect(() => timConfigSchema.parse({ updateDocs: { mode: 'invalid' } })).toThrow();
    });

    test('accepts applyLessons boolean', () => {
      const result = timConfigSchema.parse({
        updateDocs: { applyLessons: true },
      });
      expect(result.updateDocs?.applyLessons).toBe(true);
    });

    test('mode is optional', () => {
      const result = timConfigSchema.parse({ updateDocs: {} });
      expect(result.updateDocs?.mode).toBeUndefined();
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
      expect(() => timConfigSchema.parse(defaultConfig)).not.toThrow();

      const validatedConfig = timConfigSchema.parse(defaultConfig);
      expect(validatedConfig.issueTracker).toBe('github');
      expect(validatedConfig.prCreation?.draft).toBe(true); // Explicitly set in getDefaultConfig()
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

      const result = timConfigSchema.parse(config);
      expect(result.issueTracker).toBe('linear');
      expect(result.postApplyCommands).toHaveLength(1);
      expect(result.defaultExecutor).toBe('claude-code');
    });

    test('should validate issueTracker with case sensitivity', () => {
      const invalidConfig = {
        issueTracker: 'GitHub', // Wrong case
      };

      expect(() => timConfigSchema.parse(invalidConfig)).toThrow();
    });

    test('should validate issueTracker with empty string', () => {
      const invalidConfig = {
        issueTracker: '',
      };

      expect(() => timConfigSchema.parse(invalidConfig)).toThrow();
    });

    test('should validate issueTracker with undefined explicitly set', () => {
      const config = {
        issueTracker: undefined,
      };

      const result = timConfigSchema.parse(config);
      expect(result.issueTracker).toBeUndefined();
    });
  });

  describe('prCreation field', () => {
    test('should accept valid prCreation configuration with all fields', () => {
      const config = {
        prCreation: {
          draft: false,
          titlePrefix: '[Feature] ',
          autoCreatePr: 'always' as const,
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.prCreation?.draft).toBe(false);
      expect(result.prCreation?.titlePrefix).toBe('[Feature] ');
      expect(result.prCreation?.autoCreatePr).toBe('always');
    });

    test('should accept partial prCreation configuration with only draft', () => {
      const config = {
        prCreation: {
          draft: true,
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.prCreation?.draft).toBe(true);
      expect(result.prCreation?.titlePrefix).toBeUndefined();
      expect(result.prCreation?.autoCreatePr).toBeUndefined();
    });

    test('should accept partial prCreation configuration with only titlePrefix', () => {
      const config = {
        prCreation: {
          titlePrefix: '[WIP] ',
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.prCreation?.draft).toBeUndefined(); // No default in schema; applied at use-site
      expect(result.prCreation?.titlePrefix).toBe('[WIP] ');
      expect(result.prCreation?.autoCreatePr).toBeUndefined();
    });

    test('should accept valid autoCreatePr enum values', () => {
      for (const value of ['never', 'done', 'needs_review', 'always'] as const) {
        const config = {
          prCreation: {
            autoCreatePr: value,
          },
        };

        const result = timConfigSchema.parse(config);
        expect(result.prCreation?.autoCreatePr).toBe(value);
      }
    });

    test('should reject invalid autoCreatePr values', () => {
      const config = {
        prCreation: {
          autoCreatePr: 'sometimes',
        },
      };

      expect(() => timConfigSchema.parse(config)).toThrow();
    });

    test('should make autoCreatePr optional', () => {
      const config = {
        prCreation: {
          draft: false,
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.prCreation?.autoCreatePr).toBeUndefined();
    });

    test('should make prCreation field optional', () => {
      const config = {
        issueTracker: 'github' as const,
      };

      const result = timConfigSchema.parse(config);
      expect(result.prCreation).toBeUndefined();
    });

    test('should leave draft undefined when not specified in config', () => {
      const config = {
        prCreation: {
          titlePrefix: 'Test: ',
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.prCreation?.draft).toBeUndefined(); // Default applied at use-site
    });

    test('should leave draft undefined when prCreation exists but draft is undefined', () => {
      const config = {
        prCreation: {
          draft: undefined,
          titlePrefix: 'Test: ',
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.prCreation?.draft).toBeUndefined(); // Default applied at use-site
    });

    test('should preserve explicitly set draft false value', () => {
      const config = {
        prCreation: {
          draft: false,
        },
      };

      const result = timConfigSchema.parse(config);
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
        expect(() => timConfigSchema.parse(invalidConfig)).toThrow();
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
        expect(() => timConfigSchema.parse(invalidConfig)).toThrow();
      }
    });

    test('should accept empty titlePrefix string', () => {
      const config = {
        prCreation: {
          titlePrefix: '',
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.prCreation?.titlePrefix).toBe('');
      expect(result.prCreation?.draft).toBeUndefined(); // Default applied at use-site
    });

    test('should accept titlePrefix with special characters', () => {
      const config = {
        prCreation: {
          titlePrefix: '[🚀] Feature: ',
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.prCreation?.titlePrefix).toBe('[🚀] Feature: ');
    });

    test('should accept empty prCreation object', () => {
      const config = {
        prCreation: {},
      };

      const result = timConfigSchema.parse(config);
      expect(result.prCreation).toBeDefined();
      expect(result.prCreation?.draft).toBeUndefined(); // Default applied at use-site
      expect(result.prCreation?.titlePrefix).toBeUndefined();
      expect(result.prCreation?.autoCreatePr).toBeUndefined();
    });

    test('should reject unknown fields within prCreation due to strict', () => {
      const config = {
        prCreation: {
          draft: true,
          titlePrefix: 'Test: ',
          unknownField: 'invalid',
        },
      };

      expect(() => timConfigSchema.parse(config)).toThrow();
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

      const result = timConfigSchema.parse(config);
      expect(result.issueTracker).toBe('linear');
      expect(result.defaultExecutor).toBe('claude-code');
      expect(result.prCreation?.draft).toBe(false);
      expect(result.prCreation?.titlePrefix).toBe('[Feature] ');
      expect(result.review?.focusAreas).toEqual(['security']);
      expect(result.review?.outputFormat).toBe('json');
    });
  });

  describe('developmentWorkflow field', () => {
    test('should accept "pr-based" value', () => {
      const config = {
        developmentWorkflow: 'pr-based' as const,
      };

      const result = timConfigSchema.parse(config);
      expect(result.developmentWorkflow).toBe('pr-based');
    });

    test('should accept "trunk-based" value', () => {
      const config = {
        developmentWorkflow: 'trunk-based' as const,
      };

      const result = timConfigSchema.parse(config);
      expect(result.developmentWorkflow).toBe('trunk-based');
    });

    test('should reject invalid developmentWorkflow values', () => {
      const config = {
        developmentWorkflow: 'hybrid',
      };

      expect(() => timConfigSchema.parse(config)).toThrow();
    });

    test('should make developmentWorkflow optional', () => {
      const result = timConfigSchema.parse({});
      expect(result.developmentWorkflow).toBeUndefined();
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

      const result = timConfigSchema.parse(config);
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

      const result = timConfigSchema.parse(config);
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

      const result = timConfigSchema.parse(config);
      expect(result.agents?.implementer?.instructions).toBeUndefined();
      expect(result.agents?.tester?.instructions).toBe('./tester.md');
    });

    test('should reject invalid field names within agents', () => {
      const config = {
        agents: {
          invalid_agent: { instructions: './test.md' },
        },
      };

      expect(() => timConfigSchema.parse(config)).toThrow();
    });

    test('should ensure the field is optional', () => {
      const config = {
        issueTracker: 'github' as const,
      };

      const result = timConfigSchema.parse(config);
      expect(result.agents).toBeUndefined();
    });

    test('should reject non-string instructions values', () => {
      const config = {
        agents: {
          implementer: { instructions: 123 },
        },
      };

      expect(() => timConfigSchema.parse(config)).toThrow();
    });

    test('should accept empty agents object', () => {
      const config = {
        agents: {},
      };

      const result = timConfigSchema.parse(config);
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

      const result = timConfigSchema.parse(config);
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
          defaultExecutor: 'claude-code' as const,
          focusAreas: ['security', 'performance', 'testing'],
          outputFormat: 'markdown' as const,
          saveLocation: './reviews',
          customInstructionsPath: './review-instructions.md',
          incrementalReview: true,
          excludePatterns: ['*.test.ts', 'node_modules/**'],
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.review?.defaultExecutor).toBe('claude-code');
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

      const result = timConfigSchema.parse(config);
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

      const result = timConfigSchema.parse(config);
      expect(result.review).toBeDefined();
      expect(Object.keys(result.review)).toHaveLength(0);
    });

    test('should make review field optional', () => {
      const config = {
        issueTracker: 'github' as const,
      };

      const result = timConfigSchema.parse(config);
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

        expect(() => timConfigSchema.parse(config)).not.toThrow();
        const result = timConfigSchema.parse(config);
        expect(result.review?.outputFormat).toBe(format);
      }

      // Test invalid format
      const invalidConfig = {
        review: {
          outputFormat: 'invalid',
        },
      };

      expect(() => timConfigSchema.parse(invalidConfig)).toThrow();
    });

    test('should validate review defaultExecutor enum values', () => {
      const validExecutors = ['claude-code', 'codex-cli', 'both'];

      for (const executor of validExecutors) {
        const config = {
          review: {
            defaultExecutor: executor,
          },
        };

        expect(() => timConfigSchema.parse(config)).not.toThrow();
        const result = timConfigSchema.parse(config);
        expect(result.review?.defaultExecutor).toBe(executor);
      }

      const invalidConfig = {
        review: {
          defaultExecutor: 'invalid-executor',
        },
      };

      expect(() => timConfigSchema.parse(invalidConfig)).toThrow();
    });

    test('should validate focusAreas as array of strings', () => {
      const config = {
        review: {
          focusAreas: ['security', 'performance'],
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.review?.focusAreas).toEqual(['security', 'performance']);

      // Test invalid focusAreas type
      const invalidConfig = {
        review: {
          focusAreas: 'security',
        },
      };

      expect(() => timConfigSchema.parse(invalidConfig)).toThrow();
    });

    test('should validate file paths as strings', () => {
      const config = {
        review: {
          saveLocation: '/path/to/reviews',
          customInstructionsPath: '/path/to/instructions.md',
        },
      };

      const result = timConfigSchema.parse(config);
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
        expect(() => timConfigSchema.parse(invalidConfig)).toThrow();
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

      expect(() => timConfigSchema.parse(configTrue)).not.toThrow();
      expect(() => timConfigSchema.parse(configFalse)).not.toThrow();

      const resultTrue = timConfigSchema.parse(configTrue);
      const resultFalse = timConfigSchema.parse(configFalse);

      expect(resultTrue.review?.incrementalReview).toBe(true);
      expect(resultFalse.review?.incrementalReview).toBe(false);

      // Test invalid type
      const invalidConfig = {
        review: {
          incrementalReview: 'true',
        },
      };

      expect(() => timConfigSchema.parse(invalidConfig)).toThrow();
    });

    test('should validate excludePatterns as array of strings', () => {
      const config = {
        review: {
          excludePatterns: ['*.test.ts', '**/*.spec.js', 'node_modules/**'],
        },
      };

      const result = timConfigSchema.parse(config);
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
        expect(() => timConfigSchema.parse(invalidConfig)).toThrow();
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

      const result = timConfigSchema.parse(config);
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

      expect(() => timConfigSchema.parse(config)).toThrow();
    });

    test('should handle empty arrays correctly', () => {
      const config = {
        review: {
          focusAreas: [],
          excludePatterns: [],
        },
      };

      const result = timConfigSchema.parse(config);
      expect(result.review?.focusAreas).toEqual([]);
      expect(result.review?.excludePatterns).toEqual([]);
    });
  });

  describe('orchestrator and subagent executor config fields', () => {
    test('accepts defaultOrchestrator as optional string', () => {
      const config = { defaultOrchestrator: 'claude-code' };
      const result = timConfigSchema.parse(config);
      expect(result.defaultOrchestrator).toBe('claude-code');
    });

    test('accepts generate.defaultExecutor with valid executor values', () => {
      for (const value of ['claude-code', 'codex-cli'] as const) {
        const result = timConfigSchema.parse({ generate: { defaultExecutor: value } });
        expect(result.generate?.defaultExecutor).toBe(value);
      }
    });

    test('rejects invalid generate.defaultExecutor values', () => {
      expect(() =>
        timConfigSchema.parse({ generate: { defaultExecutor: 'invalid-executor' } })
      ).toThrow();
    });

    test('generate config is undefined when not specified', () => {
      const result = timConfigSchema.parse({});
      expect(result.generate).toBeUndefined();
    });

    test('defaultOrchestrator is undefined when not specified', () => {
      const result = timConfigSchema.parse({});
      expect(result.defaultOrchestrator).toBeUndefined();
    });

    test('accepts any string for defaultOrchestrator (not restricted to enum)', () => {
      const config = { defaultOrchestrator: 'codex-cli' };
      const result = timConfigSchema.parse(config);
      expect(result.defaultOrchestrator).toBe('codex-cli');
    });

    test('accepts defaultSubagentExecutor with valid enum values', () => {
      for (const value of ['codex-cli', 'claude-code', 'dynamic'] as const) {
        const result = timConfigSchema.parse({ defaultSubagentExecutor: value });
        expect(result.defaultSubagentExecutor).toBe(value);
      }
    });

    test('rejects invalid defaultSubagentExecutor values', () => {
      expect(() => timConfigSchema.parse({ defaultSubagentExecutor: 'invalid' })).toThrow();
    });

    test('defaultSubagentExecutor is undefined when not specified', () => {
      const result = timConfigSchema.parse({});
      expect(result.defaultSubagentExecutor).toBeUndefined();
    });

    test('accepts dynamicSubagentInstructions as optional string', () => {
      const instructions = 'Always use codex for Rust, claude for TypeScript.';
      const config = { dynamicSubagentInstructions: instructions };
      const result = timConfigSchema.parse(config);
      expect(result.dynamicSubagentInstructions).toBe(instructions);
    });

    test('dynamicSubagentInstructions is undefined when not specified', () => {
      const result = timConfigSchema.parse({});
      expect(result.dynamicSubagentInstructions).toBeUndefined();
    });

    test('all three fields work together with other config fields', () => {
      const config = {
        defaultOrchestrator: 'claude-code',
        defaultSubagentExecutor: 'dynamic' as const,
        dynamicSubagentInstructions: 'Prefer codex for backend.',
        defaultExecutor: 'codex-cli',
        issueTracker: 'github' as const,
      };

      const result = timConfigSchema.parse(config);
      expect(result.defaultOrchestrator).toBe('claude-code');
      expect(result.defaultSubagentExecutor).toBe('dynamic');
      expect(result.dynamicSubagentInstructions).toBe('Prefer codex for backend.');
      expect(result.defaultExecutor).toBe('codex-cli');
    });

    test('accepts terminalInput as an optional boolean', () => {
      const enabled = timConfigSchema.parse({ terminalInput: true });
      const disabled = timConfigSchema.parse({ terminalInput: false });

      expect(enabled.terminalInput).toBe(true);
      expect(disabled.terminalInput).toBe(false);
    });

    test('terminalInput is undefined when not specified', () => {
      const result = timConfigSchema.parse({});
      expect(result.terminalInput).toBeUndefined();
    });

    test('rejects non-boolean terminalInput values', () => {
      expect(() => timConfigSchema.parse({ terminalInput: 'yes' })).toThrow();
    });

    test('accepts terminalApp as an optional string', () => {
      const result = timConfigSchema.parse({ terminalApp: 'iTerm' });
      expect(result.terminalApp).toBe('iTerm');
    });

    test('terminalApp is undefined when not specified', () => {
      const result = timConfigSchema.parse({});
      expect(result.terminalApp).toBeUndefined();
    });

    test('rejects non-string terminalApp values', () => {
      expect(() => timConfigSchema.parse({ terminalApp: true })).toThrow();
    });

    test('accepts subagent model overrides per executor', () => {
      const result = timConfigSchema.parse({
        subagents: {
          implementer: {
            model: {
              claude: 'sonnet-4.6',
              codex: 'gpt-5-codex',
            },
          },
          tester: {
            model: {
              codex: 'gpt-5',
            },
          },
          verifier: {
            model: {
              claude: 'opus-4.1',
            },
          },
        },
      });

      expect(result.subagents?.implementer?.model?.claude).toBe('sonnet-4.6');
      expect(result.subagents?.implementer?.model?.codex).toBe('gpt-5-codex');
      expect(result.subagents?.tester?.model?.codex).toBe('gpt-5');
      expect(result.subagents?.verifier?.model?.claude).toBe('opus-4.1');
    });

    test('rejects unknown subagent model executors', () => {
      expect(() =>
        timConfigSchema.parse({
          subagents: {
            implementer: {
              model: {
                claudeCode: 'sonnet-4.6',
              },
            },
          },
        })
      ).toThrow();
    });
  });

  describe('planAutocompleteStatus field', () => {
    test('should accept "needs_review" value', () => {
      const result = timConfigSchema.parse({ planAutocompleteStatus: 'needs_review' });
      expect(result.planAutocompleteStatus).toBe('needs_review');
    });

    test('should accept "done" value', () => {
      const result = timConfigSchema.parse({ planAutocompleteStatus: 'done' });
      expect(result.planAutocompleteStatus).toBe('done');
    });

    test('should be undefined when not specified', () => {
      const result = timConfigSchema.parse({});
      expect(result.planAutocompleteStatus).toBeUndefined();
    });

    test('should reject invalid values', () => {
      expect(() => timConfigSchema.parse({ planAutocompleteStatus: 'invalid' })).toThrow();
    });
  });
});
