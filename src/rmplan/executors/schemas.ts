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
  includeDefaultTools: z.boolean().optional().default(true),
  disallowedTools: z.array(z.string()).optional(),
  mcpConfigFile: z.string().optional(),
  interactive: z.boolean().optional(),
  enablePermissionsMcp: z.boolean().optional(),
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
    .describe("The model string for LLM execution, e.g., 'google/gemini-2.5-pro-preview-06-05'.")
    .optional(),
});

/**
 * Schema for the 'direct-call' executor's options.
 */
export const directCallOptionsSchema = z.object({
  executionModel: z
    .string()
    .describe("The model string for LLM execution, e.g., 'google/gemini-2.5-pro-preview-06-05'.")
    .optional(),
});
