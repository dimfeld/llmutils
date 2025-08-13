import { test, describe, expect } from 'bun:test';
import { rmplanConfigSchema, getDefaultConfig } from './configSchema.js';

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

    test('should default to "github" when not specified', () => {
      const config = {};

      const result = rmplanConfigSchema.parse(config);
      expect(result.issueTracker).toBe('github');
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

    test('should return a valid configuration according to schema', () => {
      const defaultConfig = getDefaultConfig();

      // Should not throw when validating against schema
      expect(() => rmplanConfigSchema.parse(defaultConfig)).not.toThrow();

      const validatedConfig = rmplanConfigSchema.parse(defaultConfig);
      expect(validatedConfig.issueTracker).toBe('github');
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

    test('should apply default issueTracker when other fields are present', () => {
      const config = {
        defaultExecutor: 'copy-only',
        paths: {
          tasks: './tasks',
        },
      };

      const result = rmplanConfigSchema.parse(config);
      expect(result.issueTracker).toBe('github');
      expect(result.defaultExecutor).toBe('copy-only');
      expect(result.paths?.tasks).toBe('./tasks');
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
      expect(result.issueTracker).toBe('github'); // Should use default
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
});
