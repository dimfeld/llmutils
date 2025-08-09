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
  });
});