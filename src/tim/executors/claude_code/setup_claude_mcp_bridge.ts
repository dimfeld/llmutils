import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { debugLog, log } from '../../../logging.js';
import type {
  ClaudeAgentToolContext,
  ClaudePermissionPromptCoordinator,
} from './claude_mcp_protocol.js';
import {
  assertClaudeMcpServerNameAvailable,
  mergeClaudeMcpConfig,
  readUserMcpConfig,
  type ClaudeMcpServerDefinition,
} from './claude_mcp_config.js';
import {
  closeClaudeMcpParentServer,
  createClaudeMcpParentServer,
  type ClaudeMcpParentServerResources,
  type ClaudeMcpRequester,
} from './claude_mcp_parent_server.js';
import type net from 'node:net';

export interface ClaudeMcpBridgeSetupOptions {
  readonly allowedToolsMap: Map<string, true | string[]>;
  readonly interactiveApprovalEnabled?: boolean;
  readonly agentToolContext?: ClaudeAgentToolContext;
  readonly permissionPromptCoordinator?: ClaudePermissionPromptCoordinator;
  readonly mcpConfigFile?: string;
  readonly handlePermissionRequest: (
    rawMessage: unknown,
    socket: net.Socket,
    requester: ClaudeMcpRequester
  ) => Promise<void>;
}

export interface ClaudeMcpBridgeSetupResult {
  /** Path to the generated MCP config file. */
  readonly mcpConfigFile: string;
  /** Temporary directory containing the generated config and socket. */
  readonly tempDir: string;
  /** Path to the bridge log file. */
  readonly logFile: string;
  /** Parent Unix socket server. */
  readonly socketServer: net.Server;
  /** Idempotently tears down the bridge and its temporary directory. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Resolve the built Claude MCP entrypoint, with a source fallback for local
 * development and tests.
 */
export async function resolvePermissionsMcpPath(
  executableDir: string = path.dirname(process.execPath)
): Promise<string> {
  const currentDir =
    (import.meta as { dir?: string; dirname?: string }).dir ??
    (import.meta as { dirname?: string }).dirname ??
    path.dirname(new URL(import.meta.url).pathname);
  const distPath = './claude_code/tim_mcp.js';
  const candidates: string[] = [
    path.resolve(executableDir, distPath),
    path.resolve(path.dirname(process.argv0), distPath),
    path.resolve(currentDir, './tim_mcp.ts'),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return candidates.at(-1) as string;
}

/** Set up the parent socket, generated child config, and shared cleanup. */
export async function setupClaudeMcpBridge(
  options: ClaudeMcpBridgeSetupOptions
): Promise<ClaudeMcpBridgeSetupResult> {
  const userMcpConfig = await readUserMcpConfig(options.mcpConfigFile);
  assertClaudeMcpServerNameAvailable(userMcpConfig.mcpServers ?? {});
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-subagent-mcp-'));
  const socketPath = path.join(tempDir, 'permissions.sock');
  const logFile = path.join(tempDir, 'tim-mcp.log');

  let resources: ClaudeMcpParentServerResources | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = async (): Promise<void> => {
    cleanupPromise ??= (async (): Promise<void> => {
      if (resources !== undefined) {
        await closeClaudeMcpParentServer(resources, options.permissionPromptCoordinator);
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };

  try {
    resources = await createClaudeMcpParentServer(socketPath, {
      allowedToolsMap: options.allowedToolsMap,
      interactiveApprovalEnabled: options.interactiveApprovalEnabled,
      agentToolContext: options.agentToolContext,
      permissionPromptCoordinator: options.permissionPromptCoordinator,
      handlePermissionRequest: options.handlePermissionRequest,
    });

    const timMcpPath = await resolvePermissionsMcpPath();
    const childArgs = [timMcpPath, socketPath, logFile];
    if (options.agentToolContext !== undefined || options.interactiveApprovalEnabled === false) {
      childArgs.push(
        JSON.stringify({
          interactiveApprovalEnabled: options.interactiveApprovalEnabled !== false,
          agentToolNames: options.agentToolContext
            ? [...options.agentToolContext.allowedTools]
            : [],
        })
      );
    }

    const internalServer: ClaudeMcpServerDefinition = {
      type: 'stdio',
      command: 'bun',
      args: childArgs,
    };
    const mcpConfig = mergeClaudeMcpConfig(userMcpConfig, internalServer);
    const mcpConfigFile = path.join(tempDir, 'mcp-config.json');
    const mcpConfigContent = JSON.stringify(mcpConfig, null, 2);
    debugLog('MCP config file content:', mcpConfigContent);
    log(`tim MCP log file: ${logFile}`);
    await fs.writeFile(mcpConfigFile, mcpConfigContent);

    return {
      mcpConfigFile,
      tempDir,
      logFile,
      socketServer: resources.server,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
