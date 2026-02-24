import { z } from 'zod/v4';

// Executor name constants
export const ClaudeCodeExecutorName = 'claude-code';
export const CodexCliExecutorName = 'codex-cli';

/**
 * Schema for the 'claude-code' executor's options.
 */
export const claudeCodeOptionsSchema = z.object({
  allowedTools: z.array(z.string()).optional(),
  allowAllTools: z.boolean().optional(),
  includeDefaultTools: z.boolean().default(true).optional(),
  disallowedTools: z.array(z.string()).optional(),
  mcpConfigFile: z.string().optional(),
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
  simpleMode: z
    .boolean()
    .optional()
    .describe('Run executor in streamlined implement/verify mode instead of full review loop'),
});

/** Valid reasoning effort levels for Codex */
export const codexReasoningLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh']);
export type CodexReasoningLevel = z.infer<typeof codexReasoningLevelSchema>;

/**
 * Schema for the 'codex-cli' executor's options.
 */
export const codexCliOptionsSchema = z.object({
  simpleMode: z
    .boolean()
    .optional()
    .describe('Run executor in streamlined implement/verify mode instead of full review loop'),
  reasoning: z
    .object({
      default: codexReasoningLevelSchema
        .optional()
        .describe('Default reasoning level for implementation steps (default: medium)'),
      scopedReview: codexReasoningLevelSchema
        .optional()
        .describe('Reasoning level for task-scoped reviews (default: medium)'),
      fullReview: codexReasoningLevelSchema
        .optional()
        .describe('Reasoning level for full plan reviews (default: high)'),
    })
    .optional()
    .describe('Configuration for reasoning effort levels'),
});
