import * as fs from 'node:fs/promises';
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
   * Method to use for cloning/copying the repository.
   * - 'git': Standard git clone (default)
   * - 'cp': Copy using cp command (requires sourceDirectory)
   * - 'mac-cow': Copy using macOS APFS copy-on-write (requires sourceDirectory and macOS)
   */
  cloneMethod: z.enum(['git', 'cp', 'mac-cow']).optional(),
  /**
   * URL of the repository to clone.
   * Required for 'git' method. If not provided for git method, it will be inferred from the current repository's remote origin.
   */
  repositoryUrl: z.string().optional(),
  /**
   * Local source directory to copy from.
   * Required for 'cp' and 'mac-cow' methods. Should be an absolute path or relative to the main repository root.
   */
  sourceDirectory: z.string().optional(),
  /**
   * Directory where clones should be created.
   * Defaults to ~/.rmfilter/workspaces/.
   * Can be an absolute path or relative to the main repository root.
   */
  cloneLocation: z.string().optional(),
  /**
   * Array of commands to run after a clone is created and a new branch is checked out.
   */
  postCloneCommands: z.array(postApplyCommandSchema).optional(),
  /**
   * Additional glob patterns to copy when using filesystem-based clone methods.
   * Allows including files that are normally ignored by Git.
   */
  copyAdditionalGlobs: z.array(z.string()).optional(),
  /**
   * Whether to automatically create a new branch for the workspace.
   * Defaults to false.
   */
  createBranch: z.boolean().optional(),
});

export type WorkspaceCreationConfig = z.infer<typeof workspaceCreationConfigSchema>;

/**
 * Main configuration schema for rmplan.
 */
export const rmplanConfigSchema = z
  .object({
    /** Issue tracking service to use for import commands and issue-related operations. Defaults to 'github'. */
    issueTracker: z
      .enum(['github', 'linear'])
      .optional()
      .describe('Issue tracking service to use for import commands and issue-related operations'),
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
        trackingFile: z
          .string()
          .optional()
          .describe(
            'Path to workspace tracking file (default: ~/.config/rmplan/workspaces.json)'
          ),
      })
      .optional(),
    assignments: z
      .object({
        staleTimeout: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Number of days after which plan assignments are considered stale'),
      })
      .optional(),
    tags: z
      .object({
        allowed: z
          .array(z.string())
          .optional()
          .describe('List of allowed tags. If set, only these tags can be added to plans.'),
      })
      .strict()
      .optional()
      .describe('Configuration for plan tags, including allowlists'),
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
    /** Default settings for PR creation */
    prCreation: z
      .object({
        draft: z
          .boolean()
          .optional()
          .default(true)
          .describe('Whether PRs should be created as drafts by default'),
        titlePrefix: z.string().optional().describe('Prefix to add to PR titles when creating PRs'),
      })
      .strict()
      .optional()
      .describe('Configuration for PR creation behavior'),
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
        claude_mode: z
          .boolean()
          .optional()
          .describe('Default behavior for Claude mode in generate and prepare commands'),
        instructions: z
          .string()
          .optional()
          .describe('Path to a planning document file to include in all planning prompts'),
      })
      .optional(),
    /** Compaction command configuration */
    compaction: z
      .object({
        defaultExecutor: z
          .string()
          .optional()
          .describe('Default executor to use when compacting plans'),
        defaultModel: z
          .string()
          .optional()
          .describe('Default model identifier to use for compaction prompts'),
        minimumAgeDays: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Minimum age in days before a plan becomes eligible for compaction'),
        sections: z
          .object({
            details: z
              .boolean()
              .optional()
              .describe('Whether the details section should be compacted'),
            research: z
              .boolean()
              .optional()
              .describe('Whether the research section should be compacted'),
            progressNotes: z
              .boolean()
              .optional()
              .describe('Whether progress notes should be condensed into a summary'),
          })
          .optional(),
      })
      .optional(),
    /** Custom instructions for specialized agents */
    agents: z
      .object({
        implementer: z
          .object({
            instructions: z
              .string()
              .optional()
              .describe('Path to custom instructions file for the implementer agent'),
          })
          .optional(),
        tester: z
          .object({
            instructions: z
              .string()
              .optional()
              .describe('Path to custom instructions file for the tester agent'),
          })
          .optional(),
        reviewer: z
          .object({
            instructions: z
              .string()
              .optional()
              .describe('Path to custom instructions file for the reviewer agent'),
          })
          .optional(),
      })
      .strict()
      .optional()
      .describe('Custom instructions for implementer, tester, and reviewer agents'),
    /** Review-specific configuration options */
    review: z
      .object({
        /** Default focus areas for reviews (security, performance, testing, etc.) */
        focusAreas: z
          .array(z.string())
          .optional()
          .describe('Default focus areas for reviews such as security, performance, testing'),
        /** Output format for review results */
        outputFormat: z
          .enum(['json', 'markdown', 'terminal'])
          .optional()
          .describe('Format for review output: json, markdown, or terminal'),
        /** Path where review results should be saved */
        saveLocation: z
          .string()
          .optional()
          .describe('Directory path where review results should be saved'),
        /** Automatically save review results to .rmfilter/reviews/ directory */
        autoSave: z
          .boolean()
          .optional()
          .describe(
            'Automatically save review results with metadata to .rmfilter/reviews/ directory'
          ),
        /** Path to custom review instructions file */
        customInstructionsPath: z
          .string()
          .optional()
          .describe('Path to file containing custom review instructions'),
        /** Enable incremental review behavior (only review changes since last review) */
        incrementalReview: z
          .boolean()
          .optional()
          .describe('Enable incremental reviews that only analyze changes since last review'),
        /** Glob patterns to exclude from review */
        excludePatterns: z
          .array(z.string())
          .optional()
          .describe('Glob patterns for files/directories to exclude from review'),
      })
      .strict()
      .optional()
      .describe('Configuration options for the review command'),
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
    /**
     * Progress notes behavior and retention settings.
     */
    progressNotes: z
      .object({
        /**
         * Maximum number of progress notes to persist in a plan file.
         * When exceeded, the oldest notes are discarded on the next write.
         * If unset, no rotation is performed.
         */
        maxStored: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of progress notes to keep in a plan file'),
      })
      .strict()
      .optional()
      .describe('Progress notes behavior and retention'),
    /**
     * Documentation update settings.
     */
    updateDocs: z
      .object({
        /**
         * When to automatically update documentation during agent execution.
         * - 'never': Don't automatically update docs (default)
         * - 'after-iteration': Update docs after each agent loop iteration
         * - 'after-completion': Update docs only when the entire plan is complete
         */
        mode: z
          .enum(['never', 'after-iteration', 'after-completion'])
          .optional()
          .describe('When to automatically update docs during agent execution'),
        /** Model to use for documentation updates */
        model: z.string().optional().describe('Model to use for documentation updates'),
        /** Executor to use for documentation updates */
        executor: z.string().optional().describe('Executor to use for documentation updates'),
      })
      .strict()
      .optional()
      .describe('Configuration for automatic documentation updates'),
  })
  .describe('Repository-level configuration for rmplan');

export interface RmplanRuntimeConfigMetadata {
  isUsingExternalStorage?: boolean;
  externalRepositoryConfigDir?: string;
  resolvedConfigPath?: string | null;
  repositoryConfigName?: string;
  repositoryRemoteUrl?: string | null;
}

export type RmplanConfig = z.output<typeof rmplanConfigSchema> & RmplanRuntimeConfigMetadata;
export type RmplanConfigInput = z.input<typeof rmplanConfigSchema>;
export type PostApplyCommand = z.output<typeof postApplyCommandSchema>;

/**
 * Resolves the tasks directory path, handling both absolute and relative paths.
 * If tasks path is relative, it's resolved relative to the git root.
 */
export async function resolveTasksDir(config: RmplanConfig): Promise<string> {
  if (config.isUsingExternalStorage) {
    const baseDir = config.externalRepositoryConfigDir;
    if (baseDir) {
      const tasksPath = config.paths?.tasks
        ? path.isAbsolute(config.paths.tasks)
          ? config.paths.tasks
          : path.join(baseDir, config.paths.tasks)
        : path.join(baseDir, 'tasks');
      await fs.mkdir(tasksPath, { recursive: true });
      return tasksPath;
    }
  }

  const gitRoot = (await getGitRoot()) || process.cwd();

  if (config.paths?.tasks) {
    const resolvedPath = path.isAbsolute(config.paths.tasks)
      ? config.paths.tasks
      : path.join(gitRoot, config.paths.tasks);
    await fs.mkdir(resolvedPath, { recursive: true });
    return resolvedPath;
  }

  await fs.mkdir(gitRoot, { recursive: true });
  return gitRoot;
}

/**
 * Returns a default configuration object.
 * This is used when no configuration file is found or specified.
 */
export function getDefaultConfig(): RmplanConfig {
  return {
    issueTracker: 'github',
    postApplyCommands: [],
    defaultExecutor: DEFAULT_EXECUTOR,
    workspaceCreation: undefined,
    prCreation: { draft: true },
    assignments: { staleTimeout: 7 },
  };
}
