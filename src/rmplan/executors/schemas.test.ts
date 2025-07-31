import { test, describe, expect } from 'bun:test';
import { z } from 'zod/v4';
import {
  claudeCodeOptionsSchema,
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
        autoApproveCreatedFileDeletion: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.autoApproveCreatedFileDeletion).toBe(true);
      }
    });

    test('accepts false value', () => {
      const result = claudeCodeOptionsSchema.safeParse({
        autoApproveCreatedFileDeletion: false,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.autoApproveCreatedFileDeletion).toBe(false);
      }
    });

    test('is undefined when not provided (handled by consumer)', () => {
      const result = claudeCodeOptionsSchema.safeParse({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.autoApproveCreatedFileDeletion).toBeUndefined();
      }
    });

    test('is undefined when explicitly undefined (handled by consumer)', () => {
      const result = claudeCodeOptionsSchema.safeParse({
        autoApproveCreatedFileDeletion: undefined,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.autoApproveCreatedFileDeletion).toBeUndefined();
      }
    });

    test('rejects non-boolean values', () => {
      const testCases = [
        'true',
        'false',
        1,
        0,
        null,
        {},
        [],
        'yes',
        'no',
      ];

      for (const testCase of testCases) {
        const result = claudeCodeOptionsSchema.safeParse({
          autoApproveCreatedFileDeletion: testCase,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toHaveLength(1);
          expect(result.error.issues[0].path).toEqual(['autoApproveCreatedFileDeletion']);
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
        expect(result.data.autoApproveCreatedFileDeletion).toBeUndefined();
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
        autoApproveCreatedFileDeletion: true,
        permissionsMcp: {
          enabled: true,
          defaultResponse: 'no' as const,
          timeout: 5000,
        },
      };

      const result = claudeCodeOptionsSchema.safeParse(validOptions);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.autoApproveCreatedFileDeletion).toBe(true);
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
        autoApproveCreatedFileDeletion: true,
        permissionsMcp: {
          enabled: true,
          defaultResponse: 'yes' as const,
          timeout: 10000,
        },
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
        expect(result.data.autoApproveCreatedFileDeletion).toBeUndefined();
        expect(result.data.allowedTools).toBeUndefined();
        expect(result.data.allowAllTools).toBeUndefined();
        expect(result.data.disallowedTools).toBeUndefined();
        expect(result.data.mcpConfigFile).toBeUndefined();
        expect(result.data.interactive).toBeUndefined();
        expect(result.data.permissionsMcp).toBeUndefined();
      }
    });

    test('rejects invalid permissionsMcp structure when autoApproveCreatedFileDeletion is set', () => {
      const result = claudeCodeOptionsSchema.safeParse({
        autoApproveCreatedFileDeletion: true,
        permissionsMcp: {
          enabled: 'true', // Invalid type
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(issue => 
          issue.path.includes('permissionsMcp') && issue.path.includes('enabled')
        )).toBe(true);
      }
    });
  });

  describe('type inference', () => {
    test('inferred type includes autoApproveCreatedFileDeletion as optional boolean', () => {
      type ClaudeCodeOptions = z.infer<typeof claudeCodeOptionsSchema>;
      
      // This is a compile-time test - if this compiles, the types are correct
      const options1: ClaudeCodeOptions = {
        autoApproveCreatedFileDeletion: true,
      };
      
      const options2: ClaudeCodeOptions = {
        autoApproveCreatedFileDeletion: false,
      };
      
      const options3: ClaudeCodeOptions = {
        // autoApproveCreatedFileDeletion is optional, so can be omitted
      };

      // Runtime verification that the types work
      expect(typeof options1.autoApproveCreatedFileDeletion).toBe('boolean');
      expect(typeof options2.autoApproveCreatedFileDeletion).toBe('boolean');
      expect(options3.autoApproveCreatedFileDeletion).toBeUndefined();
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
    const autoApproveField = schemaShape.autoApproveCreatedFileDeletion;
    
    expect(autoApproveField).toBeDefined();
    
    // Access the description using the description property
    const description = autoApproveField.description;
    expect(typeof description).toBe('string');
    expect(description).toContain('automatically approve deletion');
    expect(description).toContain('created or modified by the agent');
    expect(description).toContain('current session');
  });

  test('schema works with partial configurations', () => {
    // Test various partial configurations that might be found in real config files
    const partialConfigs = [
      { autoApproveCreatedFileDeletion: true },
      { allowAllTools: true, autoApproveCreatedFileDeletion: false },
      { 
        permissionsMcp: { enabled: true }, 
        autoApproveCreatedFileDeletion: true 
      },
      { 
        allowedTools: ['Write'], 
        autoApproveCreatedFileDeletion: false,
        interactive: true 
      },
    ];

    for (const config of partialConfigs) {
      const result = claudeCodeOptionsSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.data.autoApproveCreatedFileDeletion).toBe('boolean');
      }
    }
  });

  test('validates edge cases for property combinations', () => {
    // Test that autoApproveCreatedFileDeletion works with permissionsMcp disabled
    const result1 = claudeCodeOptionsSchema.safeParse({
      autoApproveCreatedFileDeletion: true,
      permissionsMcp: { enabled: false },
    });
    
    expect(result1.success).toBe(true);

    // Test that autoApproveCreatedFileDeletion works when permissionsMcp is not provided
    const result2 = claudeCodeOptionsSchema.safeParse({
      autoApproveCreatedFileDeletion: true,
    });
    
    expect(result2.success).toBe(true);

    // Test that the schema accepts boolean but rejects truthy/falsy values
    const result3 = claudeCodeOptionsSchema.safeParse({
      autoApproveCreatedFileDeletion: 1, // truthy but not boolean
    });
    
    expect(result3.success).toBe(false);
  });
});