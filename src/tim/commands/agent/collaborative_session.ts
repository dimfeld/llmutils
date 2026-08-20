import { createClaudePermissionPromptCoordinator } from '../../executors/claude_code/claude_permission_prompt_coordinator.js';
import type { ClaudePermissionPromptCoordinator } from '../../executors/claude_code/claude_mcp_protocol.js';
import {
  createClaudeAgentLauncher,
  type ClaudeAgentLauncherOptions,
} from '../../executors/claude_code/claude_agent_launcher.js';
import {
  createClaudeAgentToolDispatcher,
  getClaudeAgentToolNames,
  type ClaudeAgentToolContext,
} from '../../executors/claude_code/claude_mcp_protocol.js';
import {
  createCodexAgentLauncher,
  type CodexAgentLauncherOptions,
} from '../../executors/codex_cli/codex_agent_launcher.js';
import {
  createCodexAgentToolDispatcher,
  createCodexAgentToolProvider,
} from '../../executors/codex_cli/codex_agent_tools.js';
import type { CodexDynamicToolProvider } from '../../executors/codex_cli/app_server_dynamic_tools.js';
import {
  AgentManager,
  createAgentManager,
  createAgentPreparation,
  type AgentLauncher,
} from '../../agent_messaging/index.js';
import { AGENT_EXECUTORS, type AgentExecutor } from '../../agent_messaging/contracts.js';
import { DeferredAgentInputAdapter } from '../../agent_messaging/agent_input_adapter.js';
import type {
  AgentLaunchHandle,
  AgentLaunchRequest,
} from '../../agent_messaging/agent_manager_types.js';

export interface CollaborativeAgentSessionOptions {
  readonly planId: number;
  readonly repositoryRoot: string;
  readonly configPath?: string;
  readonly orchestratorExecutor: AgentExecutor;
  readonly noninteractive: boolean;
}

/**
 * Owns activation-only state for one root `tim agent` session.
 *
 * This composition belongs to the root command because it binds provider
 * launchers and tool transports to the provider-neutral AgentManager. The
 * agent-messaging package itself only owns the manager and its contracts.
 */
export class CollaborativeAgentSession {
  public readonly manager: AgentManager;
  public readonly claudePermissionPromptCoordinator: ClaudePermissionPromptCoordinator;
  public readonly claudeAgentToolContext: ClaudeAgentToolContext;
  public readonly codexDynamicToolProvider: CodexDynamicToolProvider;
  /** Deferred root input bound by the active Claude or Codex orchestrator turn. */
  public readonly orchestratorInputAdapter: DeferredAgentInputAdapter;

  private closePromise: Promise<void> | undefined;

  private constructor(
    manager: AgentManager,
    permissionPromptCoordinator: ClaudePermissionPromptCoordinator,
    claudeAgentToolContext: ClaudeAgentToolContext,
    codexDynamicToolProvider: CodexDynamicToolProvider,
    orchestratorInputAdapter: DeferredAgentInputAdapter
  ) {
    this.manager = manager;
    this.claudePermissionPromptCoordinator = permissionPromptCoordinator;
    this.claudeAgentToolContext = claudeAgentToolContext;
    this.codexDynamicToolProvider = codexDynamicToolProvider;
    this.orchestratorInputAdapter = orchestratorInputAdapter;
  }

  public static async create(
    options: CollaborativeAgentSessionOptions
  ): Promise<CollaborativeAgentSession> {
    const permissionPromptCoordinator = createClaudePermissionPromptCoordinator();
    const orchestratorInputAdapter = new DeferredAgentInputAdapter();
    let manager: AgentManager | undefined;
    let launcher: AgentLauncher | undefined;
    const deferredLauncher: AgentLauncher = {
      launch: async (request: AgentLaunchRequest): Promise<AgentLaunchHandle> => {
        if (launcher === undefined) {
          throw new Error('Collaborative agent launchers are not ready');
        }
        return launcher.launch(request);
      },
    };

    try {
      const agentPreparer = createAgentPreparation({
        planId: options.planId,
        configPath: options.configPath,
        repositoryRoot: options.repositoryRoot,
      });
      manager = await createAgentManager({
        orchestratorExecutor: options.orchestratorExecutor,
        agentPreparer,
        agentLauncher: deferredLauncher,
        orchestratorInputAdapter,
      });

      const claudeDispatcher = createClaudeAgentToolDispatcher(manager);
      const codexDispatcher = createCodexAgentToolDispatcher(manager);
      const claudeLauncherOptions: ClaudeAgentLauncherOptions = {
        dispatcher: claudeDispatcher,
        permissionPromptCoordinator,
        noninteractive: options.noninteractive,
      };
      const codexLauncherOptions: CodexAgentLauncherOptions = {
        dispatcher: codexDispatcher,
      };
      const claudeLauncher = createClaudeAgentLauncher(claudeLauncherOptions);
      const codexLauncher = createCodexAgentLauncher(codexLauncherOptions);
      launcher = {
        launch: (request: AgentLaunchRequest): Promise<AgentLaunchHandle> => {
          switch (request.identity.executor) {
            case 'claude-code':
              return claudeLauncher.launch(request);
            case 'codex-cli':
              return codexLauncher.launch(request);
            default: {
              const unsupportedExecutor: never = request.identity.executor;
              throw new Error(
                `Unsupported collaborative agent executor: ${String(unsupportedExecutor)}`
              );
            }
          }
        },
      };

      const claudeAgentToolContext: ClaudeAgentToolContext = {
        caller: manager.orchestratorIdentity,
        allowedTools: new Set(getClaudeAgentToolNames('orchestrator')),
        dispatcher: claudeDispatcher,
      };
      const codexDynamicToolProvider = createCodexAgentToolProvider({
        caller: manager.orchestratorIdentity,
        dispatcher: codexDispatcher,
      });

      return new CollaborativeAgentSession(
        manager,
        permissionPromptCoordinator,
        claudeAgentToolContext,
        codexDynamicToolProvider,
        orchestratorInputAdapter
      );
    } catch (error) {
      await manager?.close().catch(() => undefined);
      await orchestratorInputAdapter.release().catch(() => undefined);
      await permissionPromptCoordinator.dispose().catch(() => undefined);
      throw error;
    }
  }

  /** Shut down agents, root input, and the shared Claude coordinator in order. */
  public close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = (async (): Promise<void> => {
      let firstError: unknown;
      try {
        await this.manager.close();
      } catch (error) {
        firstError = error;
      }
      try {
        await this.orchestratorInputAdapter.release();
      } catch (error) {
        firstError ??= error;
      }
      try {
        await this.claudePermissionPromptCoordinator.dispose();
      } catch (error) {
        firstError ??= error;
      }
      if (firstError !== undefined) throw firstError;
    })();
    return this.closePromise;
  }
}

export function isCollaborativeAgentExecutor(value: string): value is AgentExecutor {
  return (AGENT_EXECUTORS as readonly string[]).includes(value);
}
