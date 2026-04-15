import * as z from 'zod/v4';
import { DEFAULT_EXECUTOR } from './constants.js';
import {
  ClaudeCodeExecutorName,
  CodexCliExecutorName,
  claudeCodeOptionsSchema,
  codexCliOptionsSchema,
} from './executors/schemas.js';
import { branchPrefixSchema } from './branch_prefix.js';

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

export const lifecycleCommandContextSchema = z.enum(['agent', 'review']);
export type LifecycleCommandContext = z.infer<typeof lifecycleCommandContextSchema>;

export const lifecycleCommandSchema = z.object({
  title: z.string(),
  command: z.string(),
  mode: z
    .enum(['run', 'daemon'])
    .optional()
    .describe('Whether to run the command and wait for it to finish or run it in the background.'),
  check: z
    .string()
    .optional()
    .describe('Command to check if a daemon mode lifecycle command has finished initializting'),
  shutdown: z.string().optional().describe('Command to shutdown a daemon mode lifecycle command'),
  workingDirectory: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  allowFailure: z.boolean().optional(),
  onlyWorkspaceType: z.enum(['auto', 'standard', 'primary']).optional(),
  runIn: z
    .array(lifecycleCommandContextSchema)
    .optional()
    .describe(
      'Optional list of command contexts in which this lifecycle command should run. Omit to run in all contexts.'
    ),
});

/**
 * Schema for notification command configuration.
 */
export const notificationCommandSchema = z
  .object({
    /** The command string to execute. */
    command: z.string().optional(),
    /** Optional working directory for the command. Defaults to the repository root. */
    workingDirectory: z.string().optional(),
    /** Optional environment variables for the command. */
    env: z.record(z.string(), z.string()).optional(),
    /** Whether notifications are enabled. */
    enabled: z.boolean().optional(),
  })
  .strict();

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
   * Defaults to ~/.tim/workspaces/.
   * Can be an absolute path or relative to the main repository root.
   */
  cloneLocation: z.string().optional(),
  /**
   * Array of commands to run after a clone is created and a new branch is checked out.
   */
  postCloneCommands: z.array(postApplyCommandSchema).optional(),
  /**
   * Array of commands to run when reusing an existing workspace after it is prepared.
   */
  workspaceUpdateCommands: z.array(postApplyCommandSchema).optional(),
  /**
   * Additional glob patterns to copy when using filesystem-based clone methods.
   * Allows including files that are normally ignored by Git.
   */
  copyAdditionalGlobs: z.array(z.string()).optional(),
  /**
   * When true, auto-workspace selection will only consider workspaces with type 'auto'.
   * By default, this behavior is implicit: if any 'auto' workspace exists, only 'auto'
   * workspaces are eligible. This option forces that behavior even when no 'auto' workspaces
   * exist yet, ensuring newly created workspaces are always typed 'auto'.
   */
  requireAutoType: z.boolean().optional(),
});

export type WorkspaceCreationConfig = z.infer<typeof workspaceCreationConfigSchema>;

/**
 * Main configuration schema for tim.
 */
export const timConfigSchema = z
  .object({
    /** GitHub username used for project-wide PR filtering. */
    githubUsername: z.string().optional().describe('GitHub username for PR filtering'),
    /** Prefix to prepend to auto-generated branch names. */
    branchPrefix: branchPrefixSchema.optional(),
    /** Issue tracking service to use for import commands and issue-related operations. Defaults to 'github'. */
    issueTracker: z
      .enum(['github', 'linear'])
      .optional()
      .describe('Issue tracking service to use for import commands and issue-related operations'),
    /** An array of commands to run after changes are successfully applied by the agent. */
    postApplyCommands: z.array(postApplyCommandSchema).optional(),
    /** Notification hook configuration for agent/review completion. */
    notifications: notificationCommandSchema
      .optional()
      .describe('Configuration for notification hooks when agent/review commands finish'),
    lifecycle: z
      .object({
        commands: z.array(lifecycleCommandSchema).optional(),
      })
      .optional()
      .describe('Lifecycle commands to run before and after tim command execution'),
    headless: z
      .object({
        url: z.string().optional().describe('WebSocket URL for headless output streaming'),
      })
      .strict()
      .optional()
      .describe('Configuration for headless output streaming'),
    paths: z
      .object({
        docs: z
          .array(z.string())
          .optional()
          .describe(
            'Paths to directories to search for .md and .mdc documentation files to auto-include'
          ),
        trackingFile: z
          .string()
          .optional()
          .describe('Path to workspace tracking file (default: ~/.config/tim/workspaces.json)'),
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
    planAutocompleteStatus: z
      .enum(['needs_review', 'done'])
      .optional()
      .describe('Target status for automatic plan completion transitions'),
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
    /** Model specifications for different tim operations */
    models: z
      .object({
        execution: z.string().optional().describe('Model spec for tim run model'),
        answerPr: z.string().optional().describe('Model spec for tim answer-pr model'),
        convert_yaml: z
          .string()
          .optional()
          .describe('Model spec for tim markdown-to-yaml extraction'),
        stepGeneration: z
          .string()
          .optional()
          .describe('Model spec for tim prepare phase generation'),
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
          .describe('Whether PRs should be created as drafts by default'),
        titlePrefix: z.string().optional().describe('Prefix to add to PR titles when creating PRs'),
        autoCreatePr: z
          .enum(['never', 'done', 'needs_review', 'always'])
          .optional()
          .describe(
            'Automatically create a PR when agent completes. Values: never, done, needs_review, always'
          ),
      })
      .strict()
      .optional()
      .describe('Configuration for PR creation behavior'),
    developmentWorkflow: z
      .enum(['pr-based', 'trunk-based'])
      .optional()
      .describe('Development workflow type, affects UI button visibility'),
    /** Default settings for the generate command */
    generate: z
      .object({
        defaultExecutor: z
          .enum([ClaudeCodeExecutorName, CodexCliExecutorName])
          .optional()
          .describe('Default executor to use for the generate command'),
      })
      .strict()
      .optional()
      .describe('Configuration for tim generate defaults'),
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
    /** Default orchestrator to use for the agent command main loop */
    defaultOrchestrator: z
      .string()
      .optional()
      .describe('Default orchestrator to use for the agent command main loop'),
    /** Whether terminal input is enabled during Claude Code execution in tim agent */
    terminalInput: z
      .boolean()
      .optional()
      .describe('Whether terminal input is enabled during Claude Code execution in tim agent'),
    terminalApp: z
      .string()
      .optional()
      .describe(
        'Terminal application to use when opening new terminal windows (for example "WezTerm", "Terminal", or "iTerm"). Defaults to "WezTerm".'
      ),
    /** Default executor to use for subagents in the agent command */
    defaultSubagentExecutor: z
      .enum(['codex-cli', 'claude-code', 'dynamic'])
      .optional()
      .describe(
        'Default executor to use for subagents in the agent command (codex-cli, claude-code, or dynamic)'
      ),
    /** Instructions for the orchestrator when choosing between claude-code and codex-cli for subagent execution in dynamic mode */
    dynamicSubagentInstructions: z
      .string()
      .optional()
      .describe(
        'Instructions for the orchestrator when choosing between claude-code and codex-cli for subagent execution in dynamic mode'
      ),
    /** Model overrides for specific subagent types and executors. */
    subagents: z
      .object({
        implementer: z
          .object({
            model: z
              .object({
                claude: z.string().optional().describe('Model override for claude-code execution'),
                codex: z.string().optional().describe('Model override for codex-cli execution'),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        tester: z
          .object({
            model: z
              .object({
                claude: z.string().optional().describe('Model override for claude-code execution'),
                codex: z.string().optional().describe('Model override for codex-cli execution'),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        tddTests: z
          .object({
            model: z
              .object({
                claude: z.string().optional().describe('Model override for claude-code execution'),
                codex: z.string().optional().describe('Model override for codex-cli execution'),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        verifier: z
          .object({
            model: z
              .object({
                claude: z.string().optional().describe('Model override for claude-code execution'),
                codex: z.string().optional().describe('Model override for codex-cli execution'),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        reviewer: z
          .object({
            model: z
              .object({
                claude: z.string().optional().describe('Model override for claude-code execution'),
                codex: z.string().optional().describe('Model override for codex-cli execution'),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional()
      .describe('Per-subagent model overrides keyed by executor (claude, codex)'),
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
        tddTests: z
          .object({
            instructions: z
              .string()
              .optional()
              .describe('Path to custom instructions file for the tdd-tests agent'),
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
      .describe('Custom instructions for implementer, tester, tdd-tests, and reviewer agents'),
    /** Review-specific configuration options */
    review: z
      .object({
        /** Default executor for reviews */
        defaultExecutor: z
          .enum(['claude-code', 'codex-cli', 'both'])
          .optional()
          .describe('Default executor to use for review execution'),
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
     * - codex-cli: codexCliOptionsSchema (simpleMode, reasoning levels)
     */
    executors: z
      .object({
        [ClaudeCodeExecutorName]: claudeCodeOptionsSchema.optional(),
        [CodexCliExecutorName]: codexCliOptionsSchema.optional(),
      })
      .partial()
      .optional()
      .describe('Options for each executor'),
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
         * - 'after-review': Update docs only when the agent run finishes without review issues
         * - 'manual': Skip docs and lessons in agent; use 'tim finish' to run them
         */
        mode: z
          .enum(['never', 'after-iteration', 'after-completion', 'after-review', 'manual'])
          .optional()
          .describe('When to automatically update docs during agent execution'),
        /** Model to use for documentation updates */
        model: z.string().optional().describe('Model to use for documentation updates'),
        /** Executor to use for documentation updates */
        executor: z.string().optional().describe('Executor to use for documentation updates'),
        /** Files or patterns to include - only these files should be edited */
        include: z
          .array(z.string())
          .optional()
          .describe(
            'Descriptions of files or patterns to include - only these files should be edited during doc updates'
          ),
        /** Files or patterns to exclude - these files should never be edited */
        exclude: z
          .array(z.string())
          .optional()
          .describe(
            'Descriptions of files or patterns to exclude - these files should never be edited during doc updates'
          ),
        /** Whether to apply lessons learned to documentation after plan completion */
        applyLessons: z
          .boolean()
          .optional()
          .describe('Whether to apply lessons learned to documentation after plan completion'),
      })
      .strict()
      .optional()
      .describe('Configuration for automatic documentation updates'),
  })
  .describe('Repository-level configuration for tim');

export interface TimRuntimeConfigMetadata {
  isUsingExternalStorage?: boolean;
  externalRepositoryConfigDir?: string;
  resolvedConfigPath?: string | null;
  repositoryConfigName?: string;
  repositoryRemoteUrl?: string | null;
}

export type TimConfig = z.output<typeof timConfigSchema> & TimRuntimeConfigMetadata;
export type TimConfigInput = z.input<typeof timConfigSchema>;
export type PostApplyCommand = z.output<typeof postApplyCommandSchema>;
export type LifecycleCommand = z.infer<typeof lifecycleCommandSchema>;
export type NotificationCommand = z.output<typeof notificationCommandSchema>;

/**
 * Returns a default configuration object.
 * This is used when no configuration file is found or specified.
 */
export function getDefaultConfig(): TimConfig {
  return {
    issueTracker: 'github',
    postApplyCommands: [],
    defaultExecutor: DEFAULT_EXECUTOR,
    workspaceCreation: undefined,
    prCreation: { draft: true },
    assignments: { staleTimeout: 7 },
  };
}
