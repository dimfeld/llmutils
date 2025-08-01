import * as path from 'path';
import { z } from 'zod/v4';
import { DEFAULT_EXECUTOR } from './constants.js';
import { getGitRoot } from '../common/git.js';
import {
  ClaudeCodeExecutorName,
  CopyOnlyExecutorName,
  CopyPasteExecutorName,
  OneCallExecutorName,
  claudeCodeOptionsSchema,
  copyOnlyOptionsSchema,
  copyPasteOptionsSchema,
  directCallOptionsSchema,
} from './executors/schemas.js';

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
  env: z.record(z.string(), z.string()).optional(),
  /** Whether to allow the command to fail without stopping the process. Defaults to false. */
  allowFailure: z.boolean().optional().default(false),
  /** Whether to hide command output only the command succeeds. Defaults to false. */
  hideOutputOnSuccess: z.boolean().optional().default(false),
});

/**
 * Schema for workspace creation configuration.
 */
export const workspaceCreationConfigSchema = z.object({
  /**
   * URL of the repository to clone.
   * If method is 'rmplan' and this is not provided, it will be inferred from the current repository's remote origin.
   */
  repositoryUrl: z.string().optional(),
  /**
   * Directory where clones should be created.
   * Defaults to ~/.rmfilter/workspaces/.
   * Can be an absolute path or relative to the main repository root.
   */
  cloneLocation: z.string().optional(),
  /**
   * Array of commands to run after a clone is created and a new branch is checked out.
   * Only applicable if method is 'rmplan'.
   */
  postCloneCommands: z.array(postApplyCommandSchema).optional(),
});

export type WorkspaceCreationConfig = z.infer<typeof workspaceCreationConfigSchema>;

/**
 * Main configuration schema for rmplan.
 */
export const rmplanConfigSchema = z
  .object({
    /** An array of commands to run after changes are successfully applied by the agent. */
    postApplyCommands: z.array(postApplyCommandSchema).optional(),
    paths: z
      .object({
        tasks: z.string().optional().describe('Path to directory containing task definitions'),
        docs: z
          .array(z.string())
          .optional()
          .describe(
            'Paths to directories to search for .md and .mdc documentation files to auto-include'
          ),
        planning: z
          .string()
          .optional()
          .describe('Path to a planning document file to include in all planning prompts'),
        trackingFile: z
          .string()
          .optional()
          .describe(
            'Path to workspace tracking file (default: ~/.config/rmfilter/workspaces.json)'
          ),
      })
      .optional(),
    /** An array of strings or {find, example} pairs to automatically include as examples when they appear in prompts. */
    autoexamples: z
      .array(
        z.union([
          z.string(),
          z.object({
            find: z
              .string()
              .describe('String to search for in the prompt to trigger this example.'),
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
        answerPr: z.string().optional().describe('Model spec for rmplan answer-pr model'),
        convert_yaml: z
          .string()
          .optional()
          .describe('Model spec for rmplan markdown-to-yaml extraction'),
        stepGeneration: z
          .string()
          .optional()
          .describe('Model spec for rmplan prepare phase generation'),
      })
      .optional(),
    /** Default settings for answer-pr command */
    answerPr: z
      .object({
        mode: z
          .enum(['hybrid', 'inline', 'separate'])
          .optional()
          .describe('Default mode for answer-pr command'),
        comment: z
          .boolean()
          .optional()
          .describe('Default value for whether to add comments after processing'),
        commit: z
          .boolean()
          .optional()
          .describe('Default value for whether to commit changes after processing'),
      })
      .optional(),
    /** Custom API key environment variables for specific models or model prefixes */
    modelApiKeys: z
      .record(z.string(), z.string().describe('Environment variable name to use for API key'))
      .optional()
      .describe(
        'Map of model ID or prefix to environment variable name for API key. ' +
          'Example: {"openai/": "MY_OPENAI_KEY", "anthropic/claude-3.5-sonnet": "CLAUDE_SONNET_KEY"}'
      ),
    /** Default executor to use when not specified via --executor option */
    defaultExecutor: z.string().optional().describe('Default executor to use for plan execution'),
    /** Configuration for automatic workspace creation. */
    workspaceCreation: workspaceCreationConfigSchema.optional(),
    /** Planning-related configuration options */
    planning: z
      .object({
        direct_mode: z
          .boolean()
          .optional()
          .describe('Default behavior for direct mode in generate and prepare commands'),
      })
      .optional(),
    /**
     * Executor-specific options mapped by executor name.
     * Each executor has its own schema:
     * - claude-code: claudeCodeOptionsSchema (tools configuration, MCP settings)
     * - copy-only: copyOnlyOptionsSchema (no options)
     * - copy-paste: copyPasteOptionsSchema (executionModel)
     * - direct-call: directCallOptionsSchema (executionModel)
     */
    executors: z
      .object({
        [ClaudeCodeExecutorName]: claudeCodeOptionsSchema.optional(),
        [CopyOnlyExecutorName]: copyOnlyOptionsSchema.optional(),
        [CopyPasteExecutorName]: copyPasteOptionsSchema.optional(),
        [OneCallExecutorName]: directCallOptionsSchema.optional(),
      })
      .partial()
      .optional()
      .describe('Options for each executor'),
  })
  .describe('Repository-level configuration for rmplan');

export type RmplanConfig = z.infer<typeof rmplanConfigSchema>;
export type PostApplyCommand = z.infer<typeof postApplyCommandSchema>;

/**
 * Resolves the tasks directory path, handling both absolute and relative paths.
 * If tasks path is relative, it's resolved relative to the git root.
 */
export async function resolveTasksDir(config: any): Promise<string> {
  const gitRoot = (await getGitRoot()) || process.cwd();

  if (config.paths?.tasks) {
    return path.isAbsolute(config.paths.tasks)
      ? config.paths.tasks
      : path.join(gitRoot, config.paths.tasks);
  }

  return gitRoot;
}

/**
 * Returns a default configuration object.
 * This is used when no configuration file is found or specified.
 */
export function getDefaultConfig(): RmplanConfig {
  return {
    postApplyCommands: [],
    defaultExecutor: DEFAULT_EXECUTOR,
    workspaceCreation: undefined,
  };
}
