import { prepareSubagentExecution } from '../subagents/service.js';
import type { SubagentPreparationRequest } from '../subagents/types.js';
import type {
  AgentPreparation,
  AgentPreparationRequest,
  PreparedAgentExecution,
} from './agent_manager_types.js';

export interface AgentPreparationOptions {
  readonly planId: number;
  readonly configPath?: string;
  /** Explicit subagent model override for callers that intentionally provide one. */
  readonly model?: string;
  readonly taskIndex?: string | string[];
  readonly repositoryRoot?: string;
}

/**
 * Build the preparation dependency used by AgentManager.
 *
 * Implementer, tester, TDD-test, and collaborative reviewer agents use the
 * reusable preparation boundary. Reviewers remain separate from the formal
 * one-shot review command and receive their read-only prompt context here.
 */
export function createAgentPreparation(options: AgentPreparationOptions): AgentPreparation {
  return {
    prepare: async (request: AgentPreparationRequest): Promise<PreparedAgentExecution> => {
      const preparationRequest: SubagentPreparationRequest = {
        agentType: request.identity.type,
        planId: options.planId,
        executor: request.identity.executor,
        model: options.model,
        taskIndex: options.taskIndex,
        configPath: options.configPath,
        repositoryRoot: options.repositoryRoot,
        inputPolicy: {
          type: 'resolved',
          initialMessage: request.initialMessage,
        },
        promptContext: request.promptContext,
      };
      return prepareSubagentExecution(preparationRequest);
    },
  };
}
