import { z } from 'zod';

/**
 * Schema for a single command to be executed after applying changes.
 */
export const postApplyCommandSchema = z.object({
  /** User-friendly title for logging purposes. */
  title: z.string(),
  /** The command string to execute. */
  command: z.string(),
  /** Optional working directory for the command. Defaults to the repository root. */
  workingDirectory: z.string().optional(),
  /** Optional environment variables for the command. */
  env: z.record(z.string()).optional(),
  /** Whether to allow the command to fail without stopping the process. Defaults to false. */
  allowFailure: z.boolean().optional().default(false),
  /** Whether to hide command output only the command succeeds. Defaults to false. */
  hideOutputOnSuccess: z.boolean().optional().default(false),
});

/**
 * Main configuration schema for rmplan.
 */
export const rmplanConfigSchema = z.object({
  /** An array of commands to run after changes are successfully applied by the agent. */
  postApplyCommands: z.array(postApplyCommandSchema).optional(),
  /** An array of strings or {find, example} pairs to automatically include as examples when they appear in prompts. */
  autoexamples: z
    .array(
      z.union([
        z.string(),
        z.object({
          find: z.string().describe('String to search for in the prompt to trigger this example.'),
          example: z
            .string()
            .describe('Example string to pass as --example argument when find matches.'),
        }),
      ])
    )
    .optional(),
  /** Model specifications for different rmplan operations */
  models: z
    .object({
      execution: z.string().optional().describe('Model spec for rmplan run model'),
      convert_yaml: z
        .string()
        .optional()
        .describe('Model spec for rmplan markdown-to-yaml extraction'),
    })
    .optional(),
});

export type RmplanConfig = z.infer<typeof rmplanConfigSchema>;
export type PostApplyCommand = z.infer<typeof postApplyCommandSchema>;

/**
 * Returns a default configuration object.
 * This is used when no configuration file is found or specified.
 */
export function getDefaultConfig(): RmplanConfig {
  return { postApplyCommands: [] };
}
