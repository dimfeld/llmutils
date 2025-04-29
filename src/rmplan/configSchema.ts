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
});

/**
 * Main configuration schema for rmplan.
 */
export const rmplanConfigSchema = z.object({
  /** An array of commands to run after changes are successfully applied by the agent. */
  postApplyCommands: z.array(postApplyCommandSchema).optional(),
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
