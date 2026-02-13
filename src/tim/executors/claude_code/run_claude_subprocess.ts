/**
 * @fileoverview Shared infrastructure for running Claude Code as a subprocess.
 *
 * This module consolidates the common execution patterns used by both:
 * - `executeWithClaude()` in `tim subagent` command
 * - `executeReviewMode()` in `ClaudeCodeExecutor`
 *
 * It handles: allowed tools setup, permissions MCP, tunnel server,
 * CLI arg construction, subprocess spawning, stdout parsing, and cleanup.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import type * as net from 'net';
import { debugLog, error, log } from '../../../logging.js';
import { createLineSplitter, spawnWithStreamingIO } from '../../../common/process.js';
import { sendSinglePromptAndWait } from './streaming_input.js';
import {
  extractStructuredMessages,
  formatJsonMessage,
  resetToolUseCache,
  type FormattedClaudeMessage,
} from './format.js';
import { isTunnelActive } from '../../../logging/tunnel_client.js';
import { createTunnelServer, type TunnelServer } from '../../../logging/tunnel_server.js';
import { createPromptRequestHandler } from '../../../logging/tunnel_prompt_handler.js';
import { TIM_OUTPUT_SOCKET } from '../../../logging/tunnel_protocol.js';
import { readSharedPermissions } from '../../assignments/permissions_io.js';
import { getRepositoryIdentity } from '../../assignments/workspace_identifier.js';
import { setupPermissionsMcp } from './permissions_mcp_setup.js';

const DEFAULT_CLAUDE_MODEL = 'opus';

const JS_TASK_RUNNERS = ['npm', 'pnpm', 'yarn', 'bun'];

/**
 * Returns the canonical default allowed tools list for Claude Code subprocesses.
 * This is the single source of truth, eliminating duplication across callers.
 */
export function getDefaultAllowedTools(): string[] {
  return [
    'Edit',
    'MultiEdit',
    'Write',
    'WebFetch',
    'WebSearch',
    'Bash(cat:*)',
    'Bash(cd:*)',
    'Bash(cp:*)',
    'Bash(find:*)',
    'Bash(grep:*)',
    'Bash(ls:*)',
    'Bash(mkdir:*)',
    'Bash(mv:*)',
    'Bash(pwd)',
    'Bash(rg:*)',
    'Bash(sed:*)',
    'Bash(awk:*)',
    'Bash(rm test-:*)',
    'Bash(rm -f test-:*)',
    'Bash(git diff:*)',
    'Bash(git status:*)',
    'Bash(git log:*)',
    'Bash(git commit:*)',
    'Bash(git add:*)',
    'Bash(jj diff:*)',
    'Bash(jj status)',
    'Bash(jj log:*)',
    'Bash(jj commit:*)',
    'Bash(jj bookmark move:*)',
    ...JS_TASK_RUNNERS.flatMap((name) => [
      `Bash(${name} test:*)`,
      `Bash(${name} run build:*)`,
      `Bash(${name} run check:*)`,
      `Bash(${name} run typecheck:*)`,
      `Bash(${name} run lint:*)`,
      `Bash(${name} install)`,
      `Bash(${name} add:*)`,
    ]),
    'Bash(cargo add:*)',
    'Bash(cargo build)',
    'Bash(cargo test:*)',
    'Bash(tim add:*)',
    'Bash(tim review:*)',
    'Bash(tim set-task-done:*)',
    'Bash(tim subagent:*)',
  ];
}

/**
 * Builds the final allowed tools list by merging defaults, config additions,
 * shared permissions, and filtering out disallowed tools.
 */
export function buildAllowedToolsList(options: {
  includeDefaultTools?: boolean;
  configAllowedTools?: string[];
  disallowedTools?: string[];
  sharedPermissions?: string[];
}): string[] {
  const defaultTools = (options.includeDefaultTools ?? true) ? getDefaultAllowedTools() : [];
  let tools = [
    ...defaultTools,
    ...(options.configAllowedTools ?? []),
    ...(options.sharedPermissions ?? []),
  ];
  if (options.disallowedTools) {
    const disallowed = options.disallowedTools;
    tools = tools.filter((t) => !disallowed.includes(t));
  }
  return tools;
}

export interface ClaudeCodeSubprocessOptions {
  /** Allow all tools without permission prompts (e.g., from config or env) */
  allowAllTools?: boolean;
  /** Whether to include the default allowed tools list */
  includeDefaultTools?: boolean;
  /** Extra tools to allow beyond the defaults */
  allowedTools?: string[];
  /** Tools to remove from the allowed list */
  disallowedTools?: string[];
  /** Path to an MCP config file to pass to Claude */
  mcpConfigFile?: string;
  /** Permissions MCP configuration */
  permissionsMcp?: {
    enabled?: boolean;
    defaultResponse?: 'yes' | 'no';
    timeout?: number;
    autoApproveCreatedFileDeletion?: boolean;
  };
}

export interface RunClaudeSubprocessOptions {
  /** The prompt to send to Claude */
  prompt: string;

  /** Working directory for the subprocess */
  cwd: string;

  /** Claude Code executor options */
  claudeCodeOptions: ClaudeCodeSubprocessOptions;

  /** Whether the caller is running in non-interactive mode */
  noninteractive: boolean;

  /** Model to use (e.g., 'opus', 'sonnet') */
  model?: string;

  /** Label used in error/timeout messages (e.g., 'subagent', 'review') */
  label: string;

  /** Inactivity timeout in milliseconds. Defaults to 30 * 60 * 1000 (30 min). */
  inactivityTimeoutMs?: number;

  /** Initial inactivity timeout in ms. Defaults to 2 * 60 * 1000 (2 min). */
  initialInactivityTimeoutMs?: number;

  /**
   * Additional CLI args to pass to the claude subprocess.
   * For example, ['--json-schema', schemaString] for review mode.
   */
  extraArgs?: string[];

  /**
   * Additional access directories to pass via --add-dir.
   */
  extraAccessDirs?: string[];

  /**
   * Tracked files set for permissions MCP auto-approval of created file deletion.
   * If not provided, a fresh Set is created internally.
   */
  trackedFiles?: Set<string>;

  /**
   * Optional override for creating the permission socket server.
   * When provided, the executor's interactive handler is used instead of the
   * standalone one from permissions_mcp_setup.
   */
  createPermissionSocketServer?: (socketPath: string) => Promise<net.Server>;

  /**
   * Callback to process each batch of formatted stdout messages.
   * Called with the array of FormattedClaudeMessage from each stdout chunk.
   * Callers use this to extract their specific output data.
   */
  processFormattedMessages: (messages: FormattedClaudeMessage[]) => void;

  /** Whether to log model selection. Defaults to false. */
  logModelSelection?: boolean;
}

export interface RunClaudeSubprocessResult {
  /** Whether a result message was seen in the output stream */
  seenResultMessage: boolean;
  /** Whether the process was killed by timeout */
  killedByTimeout: boolean;
  /** The exit code of the subprocess */
  exitCode: number;
  /** Whether killed by inactivity (from spawnWithStreamingIO) */
  killedByInactivity: boolean;
}

/**
 * Loads shared permissions from cross-worktree storage.
 */
async function loadSharedPermissions(): Promise<string[]> {
  try {
    const identity = await getRepositoryIdentity();
    const shared = await readSharedPermissions({
      repositoryId: identity.repositoryId,
    });
    return shared.permissions.allow;
  } catch {
    return [];
  }
}

/**
 * Runs a Claude Code subprocess with the standard setup pattern:
 * permissions MCP, tunnel server, CLI args, streaming stdout parsing, and cleanup.
 */
export async function runClaudeSubprocess(
  options: RunClaudeSubprocessOptions
): Promise<RunClaudeSubprocessResult> {
  const {
    prompt,
    cwd,
    claudeCodeOptions,
    noninteractive,
    model,
    label,
    extraArgs,
    extraAccessDirs,
    processFormattedMessages,
    logModelSelection,
  } = options;

  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? 30 * 60 * 1000;
  const initialInactivityTimeoutMs = options.initialInactivityTimeoutMs ?? 2 * 60 * 1000;
  const trackedFiles = options.trackedFiles ?? new Set<string>();

  // Resolve allowAllTools
  let allowAllTools = claudeCodeOptions.allowAllTools;
  if (allowAllTools == null) {
    const allowAllToolsValue = process.env.ALLOW_ALL_TOOLS ?? 'false';
    allowAllTools = ['true', '1'].includes(allowAllToolsValue.toLowerCase());
  }

  // Load shared permissions and build final tools list
  const sharedPermissions = await loadSharedPermissions();
  const allowedTools = buildAllowedToolsList({
    includeDefaultTools: claudeCodeOptions.includeDefaultTools,
    configAllowedTools: claudeCodeOptions.allowedTools,
    disallowedTools: claudeCodeOptions.disallowedTools,
    sharedPermissions,
  });

  // Determine if permissions MCP should be enabled
  let isPermissionsMcpEnabled = claudeCodeOptions.permissionsMcp?.enabled === true;
  if (process.env.CLAUDE_CODE_MCP) {
    isPermissionsMcpEnabled = process.env.CLAUDE_CODE_MCP === 'true';
  }
  if (allowAllTools || noninteractive) {
    isPermissionsMcpEnabled = false;
  }

  // Set up permissions MCP if enabled
  let permissionsMcpCleanup: (() => Promise<void>) | undefined;
  let permissionsMcpConfigFile: string | undefined;
  let permissionsMcpTempDir: string | undefined;

  if (isPermissionsMcpEnabled) {
    try {
      const result = await setupPermissionsMcp({
        allowedTools,
        defaultResponse: claudeCodeOptions.permissionsMcp?.defaultResponse,
        timeout: claudeCodeOptions.permissionsMcp?.timeout,
        autoApproveCreatedFileDeletion:
          claudeCodeOptions.permissionsMcp?.autoApproveCreatedFileDeletion,
        trackedFiles,
        workingDirectory: cwd,
        createSocketServer: options.createPermissionSocketServer,
      });
      permissionsMcpConfigFile = result.mcpConfigFile;
      permissionsMcpTempDir = result.tempDir;
      permissionsMcpCleanup = result.cleanup;
    } catch (err) {
      error(`Could not set up permissions MCP for ${label}:`, err);
      isPermissionsMcpEnabled = false;
    }
  }

  // Set up tunneling for intermediate output
  let tunnelServer: TunnelServer | undefined;
  // Reuse permissions MCP temp dir if available, otherwise create a new one
  const tunnelTempDir =
    permissionsMcpTempDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), `tim-${label}-`)));
  const tunnelSocketPath = path.join(tunnelTempDir, 'output.sock');
  if (!isTunnelActive()) {
    try {
      const promptHandler = createPromptRequestHandler();
      tunnelServer = await createTunnelServer(tunnelSocketPath, {
        onPromptRequest: promptHandler,
      });
    } catch (err) {
      debugLog(`Could not create tunnel server for ${label} output forwarding:`, err);
    }
  }

  let seenResultMessage = false;
  let killedByTimeout = false;

  try {
    const args = ['claude', '--no-session-persistence'];

    // Add MCP config: permissions MCP takes priority, then user's mcpConfigFile
    if (isPermissionsMcpEnabled && permissionsMcpConfigFile) {
      args.push('--mcp-config', permissionsMcpConfigFile);
      args.push('--permission-prompt-tool', 'mcp__permissions__approval_prompt');
    } else if (claudeCodeOptions.mcpConfigFile) {
      args.push('--mcp-config', claudeCodeOptions.mcpConfigFile);
    }

    // Add allowed tools
    if (allowedTools.length && !allowAllTools) {
      args.push('--allowedTools', allowedTools.join(','));
    }

    if (allowAllTools) {
      args.push('--dangerously-skip-permissions');
    }

    if (claudeCodeOptions.disallowedTools) {
      args.push('--disallowedTools', claudeCodeOptions.disallowedTools.join(','));
    }

    // Extra access directories
    if (extraAccessDirs) {
      for (const dir of extraAccessDirs) {
        args.push('--add-dir', dir);
      }
    }

    // Model selection
    let modelToUse = model;
    if (
      modelToUse?.includes('haiku') ||
      modelToUse?.includes('sonnet') ||
      modelToUse?.includes('opus')
    ) {
      if (logModelSelection) {
        log(`Using model: ${modelToUse}\n`);
      }
      args.push('--model', modelToUse);
    } else {
      if (logModelSelection) {
        log(`Using default model: ${DEFAULT_CLAUDE_MODEL}\n`);
      }
      args.push('--model', DEFAULT_CLAUDE_MODEL);
    }

    // Streaming JSON I/O
    args.push('--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json');

    // Extra args (e.g., --json-schema for review mode)
    if (extraArgs) {
      args.push(...extraArgs);
    }

    const splitter = createLineSplitter();
    resetToolUseCache();

    if (logModelSelection) {
      log(`Interactive permissions MCP is`, isPermissionsMcpEnabled ? 'enabled' : 'disabled');
    }

    const streaming = await spawnWithStreamingIO(args, {
      env: {
        ...process.env,
        CLAUDECODE: '',
        TIM_EXECUTOR: 'claude',
        TIM_NOTIFY_SUPPRESS: '1',
        ...(tunnelServer && tunnelSocketPath ? { [TIM_OUTPUT_SOCKET]: tunnelSocketPath } : {}),
        ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
        CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: 'true',
      },
      cwd,
      inactivityTimeoutMs,
      initialInactivityTimeoutMs,
      onInactivityKill: () => {
        killedByTimeout = true;
        error(
          `Claude ${label} timed out after ${Math.round(inactivityTimeoutMs / 60000)} minutes; terminating.`
        );
      },
      formatStdout: (output) => {
        const lines = splitter(output);
        const formattedResults = lines.map(formatJsonMessage);
        const structuredMessages = extractStructuredMessages(formattedResults);

        // Track result messages and file paths
        for (const formatted of formattedResults) {
          if (formatted.type === 'result') {
            seenResultMessage = true;
          }
          if (formatted.filePaths) {
            for (const filePath of formatted.filePaths) {
              const absolutePath = path.isAbsolute(filePath)
                ? filePath
                : path.resolve(cwd, filePath);
              trackedFiles.add(absolutePath);
            }
          }
        }

        // Let the caller extract mode-specific data
        processFormattedMessages(formattedResults);

        return structuredMessages.length > 0 ? structuredMessages : '';
      },
    });

    const result = await sendSinglePromptAndWait(streaming, prompt);

    return {
      seenResultMessage,
      killedByTimeout,
      exitCode: result.exitCode,
      killedByInactivity: result.killedByInactivity ?? false,
    };
  } finally {
    tunnelServer?.close();
    // Clean up tunnel temp dir if we created a separate one (not reusing permissions MCP dir)
    if (!permissionsMcpTempDir) {
      await fs.rm(tunnelTempDir, { recursive: true, force: true });
    }
    if (permissionsMcpCleanup) {
      await permissionsMcpCleanup();
    }
  }
}
