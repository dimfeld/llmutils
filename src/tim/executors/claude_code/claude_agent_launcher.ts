import type {
  AgentLaunchHandle,
  AgentLaunchRequest,
  AgentLauncher,
} from '../../agent_messaging/agent_manager_types.js';
import type {
  ClaudeAgentToolDispatcher,
  ClaudePermissionPromptCoordinator,
} from './claude_mcp_protocol.js';
import { CLAUDE_PERSISTENT_AGENT_MODE } from './persistent_agent_contract.js';
import { runClaudeSubprocess, type ClaudeCodeSubprocessOptions } from './run_claude_subprocess.js';

export interface ClaudeAgentLauncherOptions {
  /** Manager-bound dispatcher used by every persistent Claude agent. */
  readonly dispatcher: ClaudeAgentToolDispatcher;
  /** One coordinator shared by the root and every Claude bridge in the session. */
  readonly permissionPromptCoordinator: ClaudePermissionPromptCoordinator;
}

/** Create the Claude AgentManager launch adapter. */
export function createClaudeAgentLauncher(options: ClaudeAgentLauncherOptions): AgentLauncher {
  return {
    launch: async (request: AgentLaunchRequest): Promise<AgentLaunchHandle> => {
      if (request.identity.executor !== 'claude-code') {
        throw new Error('The Claude agent launcher can only launch claude-code agents');
      }

      const configuredOptions =
        ((request.preparedExecution.config.executors as Record<string, unknown> | undefined)?.[
          'claude-code'
        ] as ClaudeCodeSubprocessOptions | undefined) ?? {};
      const agentToolContext = {
        caller: request.identity,
        allowedTools: new Set(['ListAgents', 'SendAgentMessage', 'FinishAgent'] as const),
        dispatcher: options.dispatcher,
      };

      return await runClaudeSubprocess({
        mode: CLAUDE_PERSISTENT_AGENT_MODE,
        prompt: request.preparedExecution.prompt,
        cwd: request.preparedExecution.gitRoot,
        timConfig: request.preparedExecution.config,
        timEnvironment: request.preparedExecution.timEnvironment,
        claudeCodeOptions: {
          ...configuredOptions,
          agentToolContext,
          permissionPromptCoordinator: options.permissionPromptCoordinator,
        },
        noninteractive: true,
        terminalInput: false,
        model: request.preparedExecution.model,
        label: `agent ${request.identity.name}`,
        processLabel: request.processLabel,
        lifecycleObserver: request.lifecycleObserver,
        extraAccessDirs:
          request.preparedExecution.config.isUsingExternalStorage &&
          request.preparedExecution.config.externalRepositoryConfigDir
            ? [request.preparedExecution.config.externalRepositoryConfigDir]
            : undefined,
        processFormattedMessages: () => {},
      });
    },
  };
}
