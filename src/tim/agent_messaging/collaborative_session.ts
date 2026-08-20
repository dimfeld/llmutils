import type { ClaudePermissionPromptCoordinator } from '../executors/claude_code/claude_mcp_protocol.js';
import {
  createClaudeAgentLauncher,
  type ClaudeAgentLauncherOptions,
} from '../executors/claude_code/claude_agent_launcher.js';
import {
  createClaudeAgentToolDispatcher,
  getClaudeAgentToolNames,
} from '../executors/claude_code/claude_mcp_protocol.js';
import {
  createCodexAgentLauncher,
  type CodexAgentLauncherOptions,
} from '../executors/codex_cli/codex_agent_launcher.js';
import {
  createCodexAgentToolDispatcher,
  createCodexAgentToolProvider,
} from '../executors/codex_cli/codex_agent_tools.js';
import type { CodexDynamicToolProvider } from '../executors/codex_cli/app_server_dynamic_tools.js';
import {
  AgentManager,
  createAgentManager,
  createAgentPreparation,
  type AgentLauncher,
} from './index.js';
import { AGENT_EXECUTORS, type AgentExecutor } from './contracts.js';
import { DeferredAgentInputAdapter } from './agent_input_adapter.js';
import type { AgentLaunchHandle, AgentLaunchRequest } from './agent_manager_types.js';
import type { ClaudeAgentToolContext } from '../executors/claude_code/claude_mcp_protocol.js';

export interface CollaborativeAgentSessionOptions {
  readonly planId: number;
  readonly repositoryRoot: string;
  readonly configPath?: string;
  readonly orchestratorExecutor: AgentExecutor;
  readonly permissionPromptCoordinator: ClaudePermissionPromptCoordinator;
  readonly taskIndex?: string | string[];
  readonly noninteractive?: boolean;
  readonly terminalInput?: boolean;
}

/**
 * Owns all activation-only state for one root `tim agent` session.
 *
 * The manager is created before the provider contexts so its reserved root
 * identity and dispatcher are authoritative. Provider launchers are then
 * bound to that same dispatcher and reused for every StartAgent call.
 */
export class CollaborativeAgentSession {
  public readonly manager: AgentManager;
  public readonly claudeAgentToolContext: ClaudeAgentToolContext;
  public readonly codexDynamicToolProvider: CodexDynamicToolProvider;
  /** Deferred root input bound by the active Claude or Codex orchestrator turn. */
  public readonly orchestratorInputAdapter: DeferredAgentInputAdapter;

  private closePromise: Promise<void> | undefined;

  private constructor(
    manager: AgentManager,
    claudeAgentToolContext: ClaudeAgentToolContext,
    codexDynamicToolProvider: CodexDynamicToolProvider,
    orchestratorInputAdapter: DeferredAgentInputAdapter,
    private readonly permissionPromptCoordinator: ClaudePermissionPromptCoordinator
  ) {
    this.manager = manager;
    this.claudeAgentToolContext = claudeAgentToolContext;
    this.codexDynamicToolProvider = codexDynamicToolProvider;
    this.orchestratorInputAdapter = orchestratorInputAdapter;
  }

  public static async create(
    options: CollaborativeAgentSessionOptions
  ): Promise<CollaborativeAgentSession> {
    let launcher: AgentLauncher | undefined;
    const deferredLauncher: AgentLauncher = {
      launch: async (request: AgentLaunchRequest): Promise<AgentLaunchHandle> => {
        if (launcher === undefined) {
          throw new Error('Collaborative agent launchers are not ready');
        }
        return launcher.launch(request);
      },
    };
    const orchestratorInputAdapter = new DeferredAgentInputAdapter();
    const agentPreparer = createAgentPreparation({
      planId: options.planId,
      taskIndex: options.taskIndex,
      configPath: options.configPath,
      repositoryRoot: options.repositoryRoot,
    });
    const manager = await createAgentManager({
      orchestratorExecutor: options.orchestratorExecutor,
      agentPreparer,
      agentLauncher: deferredLauncher,
      orchestratorInputAdapter,
    });

    try {
      const claudeDispatcher = createClaudeAgentToolDispatcher(manager);
      const codexDispatcher = createCodexAgentToolDispatcher(manager);
      const claudeLauncherOptions: ClaudeAgentLauncherOptions = {
        dispatcher: claudeDispatcher,
        permissionPromptCoordinator: options.permissionPromptCoordinator,
        noninteractive: options.noninteractive ?? options.terminalInput !== true,
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
        claudeAgentToolContext,
        codexDynamicToolProvider,
        orchestratorInputAdapter,
        options.permissionPromptCoordinator
      );
    } catch (error) {
      await manager.close().catch(() => undefined);
      throw error;
    }
  }

  /** Shut down agents and their session runtime before the Claude coordinator. */
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
        await this.permissionPromptCoordinator.dispose();
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
