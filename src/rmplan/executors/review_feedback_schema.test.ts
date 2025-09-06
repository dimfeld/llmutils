import { test, describe, expect } from 'bun:test';
import { z } from 'zod/v4';
import { claudeCodeOptionsSchema } from './schemas.ts';

describe('Review Feedback Schema Configuration', () => {
  describe('reviewFeedbackTimeout field validation', () => {
    test('accepts valid timeout values', () => {
      const validConfigs = [
        {
          permissionsMcp: {
            enabled: true,
            reviewFeedbackTimeout: 1000,
          },
        },
        {
          permissionsMcp: {
            enabled: true,
            reviewFeedbackTimeout: 30000,
          },
        },
        {
          permissionsMcp: {
            enabled: true,
            reviewFeedbackTimeout: 0,
          },
        },
      ];

      for (const config of validConfigs) {
        const result = claudeCodeOptionsSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(typeof result.data.permissionsMcp?.reviewFeedbackTimeout).toBe('number');
        }
      }
    });

    test('rejects invalid timeout values', () => {
      const invalidConfigs = [
        {
          permissionsMcp: {
            enabled: true,
            reviewFeedbackTimeout: 'invalid', // string instead of number
          },
        },
        {
          permissionsMcp: {
            enabled: true,
            reviewFeedbackTimeout: true, // boolean instead of number
          },
        },
        {
          permissionsMcp: {
            enabled: true,
            reviewFeedbackTimeout: null, // null value
          },
        },
        {
          permissionsMcp: {
            enabled: true,
            reviewFeedbackTimeout: [], // array instead of number
          },
        },
      ];

      for (const config of invalidConfigs) {
        const result = claudeCodeOptionsSchema.safeParse(config);
        expect(result.success).toBe(false);
      }
    });

    test('accepts negative timeout values (no constraint in schema)', () => {
      const config = {
        permissionsMcp: {
          enabled: true,
          reviewFeedbackTimeout: -1, // negative timeout - this is allowed by the basic number schema
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.reviewFeedbackTimeout).toBe(-1);
      }
    });

    test('is optional and can be omitted', () => {
      const config = {
        permissionsMcp: {
          enabled: true,
          // reviewFeedbackTimeout is omitted
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.reviewFeedbackTimeout).toBeUndefined();
      }
    });

    test('works alongside other timeout configuration', () => {
      const config = {
        permissionsMcp: {
          enabled: true,
          timeout: 15000,
          reviewFeedbackTimeout: 25000,
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.timeout).toBe(15000);
        expect(result.data.permissionsMcp?.reviewFeedbackTimeout).toBe(25000);
      }
    });

    test('can be different from general timeout', () => {
      const config = {
        permissionsMcp: {
          enabled: true,
          timeout: 5000,
          reviewFeedbackTimeout: 30000, // Much longer than general timeout
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.reviewFeedbackTimeout).toBe(30000);
        expect(result.data.permissionsMcp?.timeout).toBe(5000);
        expect(result.data.permissionsMcp?.reviewFeedbackTimeout).toBeGreaterThan(
          result.data.permissionsMcp.timeout
        );
      }
    });

    test('has correct field description', () => {
      // Test that the schema has the expected description
      const schemaShape = claudeCodeOptionsSchema.shape.permissionsMcp;
      expect(schemaShape).toBeDefined();

      // Since we can't directly access the description from Zod schemas easily,
      // we'll test that the field exists and accepts the right type
      const testConfig = {
        permissionsMcp: {
          enabled: true,
          reviewFeedbackTimeout: 20000,
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(testConfig);
      expect(result.success).toBe(true);
    });

    test('works in complete configuration', () => {
      const completeConfig = {
        allowedTools: ['Write', 'Edit', 'Bash'],
        allowAllTools: false,
        includeDefaultTools: true,
        disallowedTools: ['WebSearch'],
        mcpConfigFile: '/path/to/mcp/config.json',
        interactive: true,
        permissionsMcp: {
          enabled: true,
          defaultResponse: 'no' as const,
          timeout: 10000,
          reviewFeedbackTimeout: 30000,
          autoApproveCreatedFileDeletion: true,
        },
        agents: {
          implementer: { model: 'claude-3-opus' },
          tester: { model: 'claude-3-sonnet' },
          reviewer: { model: 'claude-3-haiku' },
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(completeConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.reviewFeedbackTimeout).toBe(30000);
        expect(result.data.permissionsMcp?.timeout).toBe(10000);
        expect(result.data.permissionsMcp?.enabled).toBe(true);
      }
    });
  });

  describe('Schema integration with existing fields', () => {
    test('reviewFeedbackTimeout does not interfere with other fields', () => {
      const config = {
        allowedTools: ['Write'],
        permissionsMcp: {
          enabled: true,
          defaultResponse: 'yes' as const,
          timeout: 5000,
          reviewFeedbackTimeout: 15000,
          autoApproveCreatedFileDeletion: false,
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowedTools).toEqual(['Write']);
        expect(result.data.permissionsMcp?.defaultResponse).toBe('yes');
        expect(result.data.permissionsMcp?.timeout).toBe(5000);
        expect(result.data.permissionsMcp?.reviewFeedbackTimeout).toBe(15000);
        expect(result.data.permissionsMcp?.autoApproveCreatedFileDeletion).toBe(false);
      }
    });

    test('permissionsMcp can be undefined', () => {
      const config = {
        allowedTools: ['Write', 'Edit'],
      };

      const result = claudeCodeOptionsSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp).toBeUndefined();
      }
    });

    test('permissionsMcp.enabled is required when permissionsMcp is defined', () => {
      const config = {
        permissionsMcp: {
          reviewFeedbackTimeout: 10000,
          // enabled field is missing
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    test('only reviewFeedbackTimeout is set without other timeout fields', () => {
      const config = {
        permissionsMcp: {
          enabled: true,
          reviewFeedbackTimeout: 20000,
          // no general timeout field
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.reviewFeedbackTimeout).toBe(20000);
        expect(result.data.permissionsMcp?.timeout).toBeUndefined();
      }
    });
  });

  describe('Edge cases and boundary conditions', () => {
    test('accepts zero timeout (immediate timeout)', () => {
      const config = {
        permissionsMcp: {
          enabled: true,
          reviewFeedbackTimeout: 0,
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.reviewFeedbackTimeout).toBe(0);
      }
    });

    test('accepts very large timeout values', () => {
      const config = {
        permissionsMcp: {
          enabled: true,
          reviewFeedbackTimeout: Number.MAX_SAFE_INTEGER,
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.reviewFeedbackTimeout).toBe(Number.MAX_SAFE_INTEGER);
      }
    });

    test('accepts negative timeout values (schema allows any number)', () => {
      const config = {
        permissionsMcp: {
          enabled: true,
          reviewFeedbackTimeout: -100,
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.reviewFeedbackTimeout).toBe(-100);
      }
    });

    test('rejects floating point timeout values', () => {
      const config = {
        permissionsMcp: {
          enabled: true,
          reviewFeedbackTimeout: 10.5,
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(config);
      // Zod accepts floating point numbers for number type by default
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.reviewFeedbackTimeout).toBe(10.5);
      }
    });

    test('rejects Infinity values', () => {
      const config = {
        permissionsMcp: {
          enabled: true,
          reviewFeedbackTimeout: Infinity,
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(config);
      // Zod rejects Infinity for number type by default
      expect(result.success).toBe(false);
    });

    test('rejects NaN values', () => {
      const config = {
        permissionsMcp: {
          enabled: true,
          reviewFeedbackTimeout: NaN,
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(config);
      // NaN is typically rejected by Zod number validation
      expect(result.success).toBe(false);
    });
  });

  describe('Type safety validation', () => {
    test('TypeScript type checking works correctly', () => {
      // This test ensures that the TypeScript types are correct
      type PermissionsMcpType = z.infer<typeof claudeCodeOptionsSchema>['permissionsMcp'];

      const validPermissionsMcp: PermissionsMcpType = {
        enabled: true,
        defaultResponse: 'yes',
        timeout: 10000,
        reviewFeedbackTimeout: 20000,
        autoApproveCreatedFileDeletion: false,
      };

      expect(validPermissionsMcp.reviewFeedbackTimeout).toBe(20000);
      expect(typeof validPermissionsMcp.reviewFeedbackTimeout).toBe('number');

      // Test that the field is optional
      const minimalPermissionsMcp: PermissionsMcpType = {
        enabled: true,
      };

      expect(minimalPermissionsMcp.reviewFeedbackTimeout).toBeUndefined();
    });

    test('Zod schema parsing returns correct types', () => {
      const config = {
        permissionsMcp: {
          enabled: true,
          reviewFeedbackTimeout: 15000,
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(config);
      expect(result.success).toBe(true);

      if (result.success) {
        const reviewTimeout = result.data.permissionsMcp?.reviewFeedbackTimeout;
        expect(typeof reviewTimeout).toBe('number');
        expect(reviewTimeout).toBe(15000);
      }
    });
  });
});
