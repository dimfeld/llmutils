import { z } from 'zod/v4';

// Executor name constants
export const ClaudeCodeExecutorName = 'claude-code';
export const CopyOnlyExecutorName = 'copy-only';
export const CopyPasteExecutorName = 'copy-paste';
export const OneCallExecutorName = 'direct-call';

/**
 * Schema for the 'claude-code' executor's options.
 */
export const claudeCodeOptionsSchema = z.object({
  allowedTools: z.array(z.string()).optional(),
  allowAllTools: z.boolean().optional(),
  includeDefaultTools: z.boolean().default(true).optional(),
  disallowedTools: z.array(z.string()).optional(),
  mcpConfigFile: z.string().optional(),
  interactive: z.boolean().optional(),
  permissionsMcp: z
    .object({
      enabled: z.boolean(),
      defaultResponse: z.enum(['yes', 'no']).optional(),
      timeout: z.number().optional().describe('Timeout in milliseconds for permission prompts'),
    })
    .optional()
    .describe('Configuration for the permissions MCP server'),
});

/**
 * Schema for the 'copy-only' executor's options.
 */
export const copyOnlyOptionsSchema = z.object({});

/**
 * Schema for the 'copy-paste' executor's options.
 */
export const copyPasteOptionsSchema = z.object({
  executionModel: z
    .string()
    .describe("The model string for LLM execution, e.g., 'google/gemini-2.5-pro'.")
    .optional(),
});

/**
 * Schema for the 'direct-call' executor's options.
 */
export const directCallOptionsSchema = z.object({
  executionModel: z
    .string()
    .describe("The model string for LLM execution, e.g., 'google/gemini-2.5-pro'.")
    .optional(),
});
