import * as path from 'node:path';

import { setupPermissionsMcp } from './permissions_mcp_setup.js';
import {
  CLAUDE_APPROVAL_MCP_TOOL_ID,
  getClaudeAgentMcpToolId,
  type ClaudeAgentToolContext,
  type ClaudePermissionPromptCoordinator,
} from './claude_mcp_protocol.js';

export interface ClaudeMcpLaunchOptions {
  readonly cwd: string;
  readonly allowedTools: readonly string[];
  readonly mcpConfigFile?: string;
  readonly interactiveApprovalRequested: boolean;
  readonly allowAllTools: boolean;
  readonly noninteractive: boolean;
  readonly disallowedTools?: readonly string[];
  readonly permissionsMcp?: {
    readonly defaultResponse?: 'yes' | 'no';
    readonly timeout?: number;
    readonly autoApproveCreatedFileDeletion?: boolean;
  };
  readonly trackedFiles: Set<string>;
  readonly agentToolContext?: ClaudeAgentToolContext;
  readonly permissionPromptCoordinator?: ClaudePermissionPromptCoordinator;
}

export interface ClaudeMcpCapabilities {
  readonly interactiveApprovalEnabled: boolean;
  readonly agentToolsEnabled: boolean;
  readonly internalMcpNeeded: boolean;
  readonly agentToolIds: string[];
}

export interface ClaudeMcpLaunchResult {
  readonly capabilities: ClaudeMcpCapabilities;
  readonly allowedTools: string[];
  readonly mcpConfigFile?: string;
  readonly tempDir?: string;
  readonly cleanup?: () => Promise<void>;
}

export function getAgentToolIds(context: ClaudeAgentToolContext | undefined): string[] {
  return context === undefined ? [] : [...context.allowedTools].map(getClaudeAgentMcpToolId);
}

export function validateAgentToolDisallowConflict(
  context: ClaudeAgentToolContext | undefined,
  disallowedTools: readonly string[] | undefined
): void {
  if (context === undefined || disallowedTools === undefined) return;
  const disallowed = new Set(disallowedTools);
  const conflictingTools = getAgentToolIds(context).filter((toolName) => disallowed.has(toolName));
  if (conflictingTools.length > 0) {
    throw new Error(
      `Claude disallowedTools prevents required agent tools: ${conflictingTools.join(', ')}`
    );
  }
}

export function resolveClaudeMcpCapabilities(options: {
  readonly interactiveApprovalRequested: boolean;
  readonly allowAllTools: boolean;
  readonly noninteractive: boolean;
  readonly agentToolContext: ClaudeAgentToolContext | undefined;
  readonly disallowedTools: readonly string[] | undefined;
}): ClaudeMcpCapabilities {
  const interactiveApprovalEnabled =
    options.interactiveApprovalRequested && !options.allowAllTools && !options.noninteractive;
  const agentToolsEnabled = options.agentToolContext !== undefined;
  const agentToolIds = getAgentToolIds(options.agentToolContext);
  validateAgentToolDisallowConflict(options.agentToolContext, options.disallowedTools);
  return {
    interactiveApprovalEnabled,
    agentToolsEnabled,
    internalMcpNeeded: interactiveApprovalEnabled || agentToolsEnabled,
    agentToolIds,
  };
}

/** Prepare one Claude bridge and the exact allowed tools for that bridge. */
export async function prepareClaudeMcpLaunch(
  options: ClaudeMcpLaunchOptions
): Promise<ClaudeMcpLaunchResult> {
  const capabilities = resolveClaudeMcpCapabilities({
    interactiveApprovalRequested: options.interactiveApprovalRequested,
    allowAllTools: options.allowAllTools,
    noninteractive: options.noninteractive,
    agentToolContext: options.agentToolContext,
    disallowedTools: options.disallowedTools,
  });
  const allowedTools = [...options.allowedTools, ...capabilities.agentToolIds];

  if (!capabilities.internalMcpNeeded) {
    return { capabilities, allowedTools };
  }

  const result = await setupPermissionsMcp({
    allowedTools,
    defaultResponse: options.permissionsMcp?.defaultResponse,
    timeout: options.permissionsMcp?.timeout,
    autoApproveCreatedFileDeletion: options.permissionsMcp?.autoApproveCreatedFileDeletion,
    trackedFiles: options.trackedFiles,
    workingDirectory: options.cwd,
    mcpConfigFile:
      options.mcpConfigFile === undefined
        ? undefined
        : path.resolve(options.cwd, options.mcpConfigFile),
    interactiveApprovalEnabled: capabilities.interactiveApprovalEnabled,
    agentToolContext: options.agentToolContext,
    permissionPromptCoordinator: options.permissionPromptCoordinator,
  });

  return {
    capabilities,
    allowedTools,
    mcpConfigFile: result.mcpConfigFile,
    tempDir: result.tempDir,
    cleanup: result.cleanup,
  };
}

/** Apply the prepared MCP config and approval tool to a Claude argument list. */
export function applyClaudeMcpLaunchArgs(
  args: string[],
  launch: ClaudeMcpLaunchResult,
  userMcpConfigFile: string | undefined
): void {
  if (launch.mcpConfigFile !== undefined) {
    args.push('--mcp-config', launch.mcpConfigFile);
    if (launch.capabilities.interactiveApprovalEnabled) {
      args.push('--permission-prompt-tool', CLAUDE_APPROVAL_MCP_TOOL_ID);
    }
  } else if (userMcpConfigFile !== undefined) {
    args.push('--mcp-config', userMcpConfigFile);
  }
}
