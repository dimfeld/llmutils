import type { SessionProcessOwner } from '../../../common/session_process_control.js';
import type {
  AgentLaunchRequest,
  AgentLaunchHandle,
  AgentLauncher,
} from '../../agent_messaging/agent_manager_types.js';
import { parseCodexModel } from './model.js';
import {
  createCodexAgentToolProvider,
  type CodexAgentToolDispatcher,
} from './codex_agent_tools.js';
import { CODEX_PERSISTENT_AGENT_MODE } from './persistent_agent_contract.js';
import { startPersistentCodexAgent } from './persistent_codex_session.js';

export interface CodexAgentLauncherOptions {
  /** Manager-bound dispatcher used by every agent tool provider. */
  readonly dispatcher: CodexAgentToolDispatcher;
  /** Test seam and explicit owner for callers outside the ambient session. */
  readonly sessionProcessOwner?: Pick<SessionProcessOwner, 'prepareLogicalExecutor'>;
}

/**
 * Create the Codex AgentManager launch adapter.
 *
 * The manager supplies the prepared prompt, model, environment, stable
 * identity, process label, and an observer before launch. This adapter adds
 * only the Codex-specific dynamic-tool provider and persistent session mode.
 */
export function createCodexAgentLauncher(options: CodexAgentLauncherOptions): AgentLauncher {
  return {
    launch: async (request: AgentLaunchRequest): Promise<AgentLaunchHandle> => {
      if (request.identity.executor !== 'codex-cli') {
        throw new Error('The Codex agent launcher can only launch codex-cli agents');
      }

      const parsedModel = parseCodexModel(request.preparedExecution.model);
      const dynamicToolProvider = createCodexAgentToolProvider({
        caller: request.identity,
        dispatcher: options.dispatcher,
      });

      return await startPersistentCodexAgent({
        mode: CODEX_PERSISTENT_AGENT_MODE,
        identity: request.identity,
        prompt: request.preparedExecution.prompt,
        cwd: request.preparedExecution.gitRoot,
        timConfig: request.preparedExecution.config,
        model: parsedModel.model,
        reasoningLevel: parsedModel.reasoningLevel,
        timEnvironment: request.preparedExecution.timEnvironment,
        dynamicToolProvider,
        processLabel: request.processLabel,
        lifecycleObserver: request.lifecycleObserver,
        ...(options.sessionProcessOwner === undefined
          ? {}
          : { sessionProcessOwner: options.sessionProcessOwner }),
      });
    },
  };
}
