import { z } from 'zod';
import { DEFAULT_EXECUTOR } from './executors/index.js';

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
 * Valid methods for workspace creation.
 */
export const workspaceCreationMethodSchema = z.enum(['script', 'rmplan']);
export type WorkspaceCreationMethod = z.infer<typeof workspaceCreationMethodSchema>;

/**
 * Schema for workspace creation configuration.
 */
export const workspaceCreationConfigSchema = z
  .object({
    /** Method to use for workspace creation. If not provided, workspace creation is disabled. */
    method: workspaceCreationMethodSchema.optional(),
    /** Path to a script for workspace creation. Required if method is 'script'. */
    scriptPath: z.string().optional(),
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
  })
  .refine(
    (data) => {
      // If method is 'script', scriptPath must be provided
      if (data.method === 'script' && !data.scriptPath) {
        return false;
      }
      return true;
    },
    {
      message: "When method is 'script', scriptPath must be provided",
      path: ['scriptPath'],
    }
  );

export type WorkspaceCreationConfig = z.infer<typeof workspaceCreationConfigSchema>;

/**
 * Main configuration schema for rmplan.
 */
export const rmplanConfigSchema = z.object({
  /** An array of commands to run after changes are successfully applied by the agent. */
  postApplyCommands: z.array(postApplyCommandSchema).optional(),
  paths: z
    .object({
      tasks: z.string().optional().describe('Path to directory containing task definitions'),
    })
    .optional(),
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
      answerPr: z.string().optional().describe('Model spec for rmplan answer-pr model'),
      convert_yaml: z
        .string()
        .optional()
        .describe('Model spec for rmplan markdown-to-yaml extraction'),
    })
    .optional(),
  /** Default executor to use when not specified via --executor option */
  defaultExecutor: z
    .string()
    .default(DEFAULT_EXECUTOR)
    .describe('Default executor to use for plan execution'),
  /** Configuration for automatic workspace creation. */
  workspaceCreation: workspaceCreationConfigSchema.optional(),
});

export type RmplanConfig = z.infer<typeof rmplanConfigSchema>;
export type PostApplyCommand = z.infer<typeof postApplyCommandSchema>;

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
