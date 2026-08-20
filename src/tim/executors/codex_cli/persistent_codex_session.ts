import type { TimConfig } from '../../configSchema.js';
import type { TimWorkspaceCommandEnvironmentOptions } from '../../../common/env.js';
import { normalizeSubprocessMonitorRules } from '../../../common/subprocess_monitor.js';
import type { SessionProcessOwner } from '../../../common/session_process_control.js';
import type {
  AgentIdentity,
  AgentProviderLifecycleObserver,
} from '../../agent_messaging/agent_manager_types.js';
import type { AgentProcessLabel } from '../../agent_messaging/agent_process_labels.js';
import { formatAgentProcessLabel } from '../../agent_messaging/agent_process_labels.js';
import {
  validateCodexAgentToolProvider,
  validateCodexDynamicToolCaller,
  type CodexAgentToolContext,
} from './codex_agent_tools.js';
import {
  CODEX_DYNAMIC_TOOLS_APP_SERVER_REQUIRED_ERROR_MESSAGE,
  type CodexDynamicToolProvider,
} from './app_server_dynamic_tools.js';
import { isCodexAppServerEnabled } from './app_server_mode.js';
import type { CodexReasoningLevel } from '../schemas.js';
import {
  CODEX_PERSISTENT_AGENT_MODE,
  type CodexPersistentAgentLaunchHandle,
} from './persistent_agent_contract.js';
import { PersistentCodexTurnController } from './persistent_codex_turn_controller.js';
import { PersistentCodexSessionRuntime } from './persistent_codex_session_runtime.js';

export interface CodexPersistentAgentLaunchOptions {
  readonly mode: typeof CODEX_PERSISTENT_AGENT_MODE;
  readonly identity: AgentIdentity;
  readonly prompt: string;
  readonly cwd: string;
  readonly timConfig: TimConfig;
  readonly model?: string;
  readonly reasoningLevel?: CodexReasoningLevel;
  readonly timEnvironment?: TimWorkspaceCommandEnvironmentOptions;
  readonly dynamicToolProvider: CodexDynamicToolProvider<CodexAgentToolContext>;
  readonly processLabel: AgentProcessLabel;
  readonly lifecycleObserver: AgentProviderLifecycleObserver;
  readonly outputSchema?: Record<string, unknown>;
  readonly outputSchemaPath?: string;
  readonly terminalInput?: boolean;
  /** Test seam; production callers use the ambient session process owner. */
  readonly sessionProcessOwner?: Pick<SessionProcessOwner, 'prepareLogicalExecutor'>;
}

/** Validate static requirements before creating any provider resource. */
export function validateCodexPersistentAgentLaunchOptions(
  options: unknown
): asserts options is CodexPersistentAgentLaunchOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('Codex persistent-agent launch options must be an object');
  }
  const value = options as Record<string, unknown>;
  if (value.mode !== CODEX_PERSISTENT_AGENT_MODE) {
    throw new TypeError('Codex persistent-agent mode must be persistent-agent');
  }
  if (typeof value.prompt !== 'string') {
    throw new TypeError('Codex persistent-agent prompt must be a string');
  }
  if (typeof value.cwd !== 'string' || value.cwd.trim().length === 0) {
    throw new TypeError('Codex persistent-agent cwd must be a non-empty string');
  }
  if (typeof value.timConfig !== 'object' || value.timConfig === null) {
    throw new TypeError('Codex persistent-agent timConfig must be an object');
  }
  if (value.identity === undefined) {
    throw new TypeError('Codex persistent-agent identity is required');
  }
  validateCodexDynamicToolCaller(value.identity);
  const identity = value.identity as AgentIdentity;
  if (identity.role !== 'subagent') {
    throw new TypeError('Codex persistent-agent identity must be a subagent');
  }
  if (typeof value.processLabel !== 'string' || value.processLabel.trim().length === 0) {
    throw new TypeError('Codex persistent-agent process label must be a non-empty string');
  }
  const expectedProcessLabel = formatAgentProcessLabel('codex-cli', identity.name);
  if (value.processLabel !== expectedProcessLabel) {
    throw new TypeError(`Codex persistent-agent process label must be ${expectedProcessLabel}`);
  }
  if (value.outputSchema !== undefined || value.outputSchemaPath !== undefined) {
    throw new TypeError('Codex persistent agents do not support output schemas');
  }
  if (value.appServerMode !== undefined) {
    throw new TypeError('Codex persistent agents select app-server mode themselves');
  }
  if (value.inactivityTimeoutMs !== undefined) {
    throw new TypeError('Codex persistent agents do not accept one-shot inactivity timeouts');
  }
  if (value.terminalInput === true) {
    throw new TypeError('Codex persistent agents do not support terminal input');
  }
  if (value.lifecycleObserver === undefined) {
    throw new TypeError('Codex persistent-agent lifecycle observer is required');
  }
  if (value.dynamicToolProvider === undefined) {
    throw new TypeError('Codex persistent-agent dynamic tool provider is required');
  }
  const provider = value.dynamicToolProvider as CodexDynamicToolProvider<CodexAgentToolContext>;
  validateCodexAgentToolProvider(provider);
  assertProviderIdentity(provider, identity);
  if (!isCodexAppServerEnabled()) {
    throw new Error(CODEX_DYNAMIC_TOOLS_APP_SERVER_REQUIRED_ERROR_MESSAGE);
  }
}

/** Start one private, named Codex app-server session and its first turn. */
export async function startPersistentCodexAgent(
  options: CodexPersistentAgentLaunchOptions
): Promise<CodexPersistentAgentLaunchHandle> {
  validateCodexPersistentAgentLaunchOptions(options);
  const monitorRules = options.timConfig.subprocessMonitor?.rules;
  if (monitorRules?.length) normalizeSubprocessMonitorRules(monitorRules);

  const runtime = new PersistentCodexSessionRuntime(options);
  const controller = new PersistentCodexTurnController(options, runtime);
  return controller.start();
}

function assertProviderIdentity(
  provider: CodexDynamicToolProvider<CodexAgentToolContext>,
  identity: AgentIdentity
): void {
  const caller = provider.context.caller;
  if (
    caller.id !== identity.id ||
    caller.name !== identity.name ||
    caller.role !== identity.role ||
    caller.executor !== identity.executor ||
    caller.role !== 'subagent' ||
    identity.role !== 'subagent' ||
    caller.type !== identity.type
  ) {
    throw new TypeError(
      'Codex dynamic tool provider is not bound to the persistent agent identity'
    );
  }
}
