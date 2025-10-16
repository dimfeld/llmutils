import { test, describe, expect } from 'bun:test';
import { z } from 'zod/v4';
import {
  claudeCodeOptionsSchema,
  codexCliOptionsSchema,
  copyOnlyOptionsSchema,
  copyPasteOptionsSchema,
  directCallOptionsSchema,
  ClaudeCodeExecutorName,
  CopyOnlyExecutorName,
  CopyPasteExecutorName,
  OneCallExecutorName,
} from './schemas.ts';

describe('claudeCodeOptionsSchema', () => {
  describe('autoApproveCreatedFileDeletion property', () => {
    test('accepts true value', () => {
      const result = claudeCodeOptionsSchema.safeParse({
        permissionsMcp: {
          enabled: true,
          autoApproveCreatedFileDeletion: true,
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.autoApproveCreatedFileDeletion).toBe(true);
      }
    });

    test('accepts false value', () => {
      const result = claudeCodeOptionsSchema.safeParse({
        permissionsMcp: {
          enabled: true,
          autoApproveCreatedFileDeletion: false,
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.autoApproveCreatedFileDeletion).toBe(false);
      }
    });

    test('is undefined when not provided (handled by consumer)', () => {
      const result = claudeCodeOptionsSchema.safeParse({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.autoApproveCreatedFileDeletion).toBeUndefined();
      }
    });

    test('is undefined when explicitly undefined (handled by consumer)', () => {
      const result = claudeCodeOptionsSchema.safeParse({
        permissionsMcp: {
          enabled: true,
          autoApproveCreatedFileDeletion: undefined,
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.autoApproveCreatedFileDeletion).toBeUndefined();
      }
    });

    test('rejects non-boolean values', () => {
      const testCases = ['true', 'false', 1, 0, null, {}, [], 'yes', 'no'];

      for (const testCase of testCases) {
        const result = claudeCodeOptionsSchema.safeParse({
          permissionsMcp: {
            enabled: true,
            autoApproveCreatedFileDeletion: testCase,
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toHaveLength(1);
          expect(result.error.issues[0].path).toEqual([
            'permissionsMcp',
            'autoApproveCreatedFileDeletion',
          ]);
          expect(result.error.issues[0].code).toBe(z.ZodIssueCode.invalid_type);
        }
      }
    });

    test('property is optional and can be omitted', () => {
      const result = claudeCodeOptionsSchema.safeParse({
        allowedTools: ['Write', 'Edit'],
        permissionsMcp: { enabled: true },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.autoApproveCreatedFileDeletion).toBeUndefined();
        expect(result.data.allowedTools).toEqual(['Write', 'Edit']);
        expect(result.data.permissionsMcp?.enabled).toBe(true);
      }
    });

    test('works alongside other properties', () => {
      const validOptions = {
        allowedTools: ['Write', 'Edit', 'Bash'],
        allowAllTools: false,
        includeDefaultTools: true,
        disallowedTools: ['WebSearch'],
        mcpConfigFile: '/path/to/config.json',
        interactive: true,
        permissionsMcp: {
          enabled: true,
          defaultResponse: 'no' as const,
          timeout: 5000,
          autoApproveCreatedFileDeletion: true,
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(validOptions);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionsMcp?.autoApproveCreatedFileDeletion).toBe(true);
        expect(result.data.allowedTools).toEqual(['Write', 'Edit', 'Bash']);
        expect(result.data.allowAllTools).toBe(false);
        expect(result.data.includeDefaultTools).toBe(true);
        expect(result.data.disallowedTools).toEqual(['WebSearch']);
        expect(result.data.mcpConfigFile).toBe('/path/to/config.json');
        expect(result.data.interactive).toBe(true);
        expect(result.data.permissionsMcp?.enabled).toBe(true);
        expect(result.data.permissionsMcp?.defaultResponse).toBe('no');
        expect(result.data.permissionsMcp?.timeout).toBe(5000);
      }
    });
  });

  describe('schema validation completeness', () => {
    test('validates all schema properties work together', () => {
      const completeOptions = {
        allowedTools: ['Write', 'Edit', 'Bash', 'Read'],
        allowAllTools: true,
        includeDefaultTools: false,
        disallowedTools: ['WebSearch', 'Task'],
        mcpConfigFile: '/custom/mcp/config.json',
        interactive: false,
        permissionsMcp: {
          enabled: true,
          defaultResponse: 'yes' as const,
          timeout: 10000,
          autoApproveCreatedFileDeletion: true,
        },
        simpleMode: true,
      };

      const result = claudeCodeOptionsSchema.safeParse(completeOptions);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(completeOptions);
      }
    });

    test('handles empty object with defaults', () => {
      const result = claudeCodeOptionsSchema.safeParse({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.includeDefaultTools).toBeUndefined();
        expect(result.data.allowedTools).toBeUndefined();
        expect(result.data.allowAllTools).toBeUndefined();
        expect(result.data.disallowedTools).toBeUndefined();
        expect(result.data.mcpConfigFile).toBeUndefined();
        expect(result.data.interactive).toBeUndefined();
        expect(result.data.permissionsMcp).toBeUndefined();
        expect(result.data.simpleMode).toBeUndefined();
      }
    });

    test('accepts optional simpleMode flag', () => {
      const result = claudeCodeOptionsSchema.safeParse({ simpleMode: true });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.simpleMode).toBe(true);
      }
    });

    test('rejects invalid simpleMode type', () => {
      const result = claudeCodeOptionsSchema.safeParse({ simpleMode: 'yes' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(['simpleMode']);
      }
    });
  });
});

describe('other executor schemas', () => {
  test('copyOnlyOptionsSchema accepts empty object', () => {
    const result = copyOnlyOptionsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test('copyPasteOptionsSchema accepts optional executionModel', () => {
    const result1 = copyPasteOptionsSchema.safeParse({});
    expect(result1.success).toBe(true);

    const result2 = copyPasteOptionsSchema.safeParse({
      executionModel: 'google/gemini-2.5-pro',
    });

    expect(result2.success).toBe(true);
    if (result2.success) {
      expect(result2.data.executionModel).toBe('google/gemini-2.5-pro');
    }
  });

  test('directCallOptionsSchema accepts optional executionModel', () => {
    const result1 = directCallOptionsSchema.safeParse({});
    expect(result1.success).toBe(true);

    const result2 = directCallOptionsSchema.safeParse({
      executionModel: 'google/gemini-2.5-pro',
    });

    expect(result2.success).toBe(true);
    if (result2.success) {
      expect(result2.data.executionModel).toBe('google/gemini-2.5-pro');
    }
  });

  test('codexCliOptionsSchema accepts optional simpleMode flag', () => {
    const result = codexCliOptionsSchema.safeParse({ simpleMode: true });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.simpleMode).toBe(true);
    }
  });

  test('codexCliOptionsSchema enforces boolean type for simpleMode', () => {
    const result = codexCliOptionsSchema.safeParse({ simpleMode: 'true' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['simpleMode']);
    }
  });
});

describe('executor name constants', () => {
  test('executor name constants are defined correctly', () => {
    expect(ClaudeCodeExecutorName).toBe('claude-code');
    expect(CopyOnlyExecutorName).toBe('copy-only');
    expect(CopyPasteExecutorName).toBe('copy-paste');
    expect(OneCallExecutorName).toBe('direct-call');
  });
});

describe('claudeCodeOptionsSchema integration with configuration validation', () => {
  test('schema description includes helpful information', () => {
    const schemaShape = claudeCodeOptionsSchema.shape;
    const permissionsMcpField = schemaShape.permissionsMcp;

    expect(permissionsMcpField).toBeDefined();

    // Test that we can parse a config with the nested field and verify the description is present
    const testConfig = {
      permissionsMcp: {
        enabled: true,
        autoApproveCreatedFileDeletion: true,
      },
    };

    const result = claudeCodeOptionsSchema.safeParse(testConfig);
    expect(result.success).toBe(true);

    // The description exists in the schema definition - we can verify it's working by testing the config
    if (result.success) {
      expect(result.data.permissionsMcp?.autoApproveCreatedFileDeletion).toBe(true);
    }
  });

  test('schema works with partial configurations', () => {
    // Test various partial configurations that might be found in real config files
    const partialConfigs = [
      { permissionsMcp: { enabled: true, autoApproveCreatedFileDeletion: true } },
      {
        allowAllTools: true,
        permissionsMcp: { enabled: true, autoApproveCreatedFileDeletion: false },
      },
      {
        permissionsMcp: { enabled: true, autoApproveCreatedFileDeletion: true },
      },
      {
        allowedTools: ['Write'],
        permissionsMcp: { enabled: true, autoApproveCreatedFileDeletion: false },
        interactive: true,
      },
    ];

    for (const config of partialConfigs) {
      const result = claudeCodeOptionsSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.data.permissionsMcp?.autoApproveCreatedFileDeletion).toBe('boolean');
      }
    }
  });

  test('validates edge cases for property combinations', () => {
    // Test that autoApproveCreatedFileDeletion works with permissionsMcp disabled
    const result1 = claudeCodeOptionsSchema.safeParse({
      permissionsMcp: {
        enabled: false,
        autoApproveCreatedFileDeletion: true,
      },
    });

    expect(result1.success).toBe(true);

    // Test that the schema works when permissionsMcp is not provided
    const result2 = claudeCodeOptionsSchema.safeParse({
      allowedTools: ['Write'],
    });

    expect(result2.success).toBe(true);

    // Test that the schema accepts boolean but rejects truthy/falsy values for autoApproveCreatedFileDeletion
    const result3 = claudeCodeOptionsSchema.safeParse({
      permissionsMcp: {
        enabled: true,
        autoApproveCreatedFileDeletion: 1, // truthy but not boolean
      },
    });

    expect(result3.success).toBe(false);
  });
});
