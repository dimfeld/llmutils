import type { TimConfig } from '../../configSchema';
import type { CodexReasoningLevel } from '../schemas.js';
import type { TimWorkspaceCommandEnvironmentOptions } from '../../../common/env.js';
import { executeCodexStepViaAppServer } from './app_server_runner';
import type { CodexDynamicToolProvider } from './app_server_dynamic_tools.js';
import type { DeferredAgentInputAdapter } from '../../agent_messaging/agent_input_adapter.js';
import type { AgentEnvironmentIdentity } from '../../agent_messaging/environment.js';

export {
  startPersistentCodexAgent,
  validateCodexPersistentAgentLaunchOptions,
} from './persistent_codex_session.js';
export type { CodexPersistentAgentLaunchOptions } from './persistent_codex_session.js';
export { createCodexAgentLauncher } from './codex_agent_launcher.js';
export type { CodexAgentLauncherOptions } from './codex_agent_launcher.js';
export { createCodexAgentToolDispatcher } from './codex_agent_tools.js';

export type CodexAppServerMode = 'single-turn' | 'chat-session' | 'single-turn-with-steering';

export interface CodexStepOptions {
  /** Optional model override passed through from executor/shared options. */
  model?: string;
  /** Path to JSON schema file for structured output */
  outputSchemaPath?: string;
  /** Inline JSON schema object for structured output. */
  outputSchema?: Record<string, unknown>;
  /** Inactivity timeout in milliseconds. Defaults to 10 minutes (or CODEX_OUTPUT_TIMEOUT_MS env var). */
  inactivityTimeoutMs?: number;
  /** Reasoning effort level for the model. Defaults to 'high'. */
  reasoningLevel?: CodexReasoningLevel;
  /** App-server interaction mode. Defaults to single-turn. */
  appServerMode?: CodexAppServerMode;
  /** Enable local terminal input forwarding for app-server interactive modes. */
  terminalInput?: boolean;
  /** Project environment rendering options for Codex subprocesses. */
  timEnvironment?: TimWorkspaceCommandEnvironmentOptions;
  /** Trusted agent identity applied after all workspace environment layers. */
  agentEnvironmentIdentity?: AgentEnvironmentIdentity;
  /** One trusted, role-bound provider for experimental Codex dynamic tools. */
  dynamicToolProvider?: CodexDynamicToolProvider;
  /** Deferred root input bound by the active orchestrator app-server turn. */
  orchestratorInputAdapter?: DeferredAgentInputAdapter;
  /**
   * Offer the `EndTimSession` dynamic tool. Only takes effect in an
   * interactive `chat-session` that would otherwise wait for more input. The session closes
   * after the turn in which the agent calls the tool completes.
   */
  endSessionTool?: boolean;
}

/**
 * Runs a single-step Codex execution through the Codex app-server and returns the final agent message.
 */
export async function executeCodexStep(
  prompt: string,
  cwd: string,
  timConfig: TimConfig,
  options: CodexStepOptions = {}
): Promise<string> {
  return executeCodexStepViaAppServer(prompt, cwd, timConfig, options);
}
