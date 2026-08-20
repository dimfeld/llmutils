import { prepareSubagentExecution } from '../subagents/service.js';
import type { SubagentPreparationRequest, SubagentType } from '../subagents/types.js';
import type {
  AgentPreparation,
  AgentPreparationRequest,
  PreparedAgentExecution,
} from './agent_manager_types.js';

export interface AgentPreparationOptions {
  readonly planId: number;
  readonly configPath?: string;
  readonly model?: string;
  readonly taskIndex?: string | string[];
  readonly repositoryRoot?: string;
  readonly prepareReviewer?: CollaborativeReviewerPreparation;
}

/** Narrow hook for a collaborative reviewer, separate from formal review. */
export type CollaborativeReviewerPreparation = (
  request: AgentPreparationRequest
) => Promise<PreparedAgentExecution>;

/**
 * Build the preparation dependency used by AgentManager.
 *
 * Implementer, tester, and TDD-test agents use the reusable plan 414 service.
 * Reviewers must be supplied by a caller that owns collaborative, read-only
 * reviewer preparation; this function never invokes the formal review path.
 */
export function createAgentPreparation(options: AgentPreparationOptions): AgentPreparation {
  return {
    prepare: async (request: AgentPreparationRequest): Promise<PreparedAgentExecution> => {
      const promptContext = request.promptContext ?? { mode: 'persistent-agent' as const };
      if (request.identity.type === 'reviewer') {
        if (options.prepareReviewer === undefined) {
          throw new Error('Collaborative reviewer preparation is not configured');
        }
        return options.prepareReviewer({ ...request, promptContext });
      }

      const preparationRequest: SubagentPreparationRequest = {
        agentType: request.identity.type as SubagentType,
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
        promptContext,
      };
      return prepareSubagentExecution(preparationRequest);
    },
  };
}
