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
      reviewFeedbackTimeout: z
        .number()
        .optional()
        .describe('Timeout in milliseconds for review feedback prompts'),
      autoApproveCreatedFileDeletion: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          'When enabled, automatically approve deletion of files created or modified by the agent in the current session'
        ),
    })
    .optional()
    .describe('Configuration for the permissions MCP server'),
  agents: z
    .object({
      implementer: z
        .object({
          model: z.string().optional().describe('Model to use for the implementer agent'),
        })
        .optional(),
      tester: z
        .object({
          model: z.string().optional().describe('Model to use for the tester agent'),
        })
        .optional(),
      reviewer: z
        .object({
          model: z.string().optional().describe('Model to use for the reviewer agent'),
        })
        .optional(),
    })
    .optional()
    .describe('Configuration for specialized agents'),
  enableReviewFeedback: z
    .boolean()
    .default(false)
    .optional()
    .describe('Enable the review feedback MCP tool for interactive review feedback'),
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
