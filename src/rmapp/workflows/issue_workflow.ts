import { StateMachine, type StateMachineConfig } from '../../state_machine/index.js';
import type { IssueWorkflowContext, WorkflowEvent } from './types.js';
import {
  type IssueWorkflowState,
  AnalyzeIssueNode,
  GeneratePlanNode,
  ImplementIssueNode,
  TestImplementationNode,
  CreatePRNode,
  IssueCompleteNode,
  IssueFailedNode,
} from './issue_nodes.js';

export const issueWorkflowConfig: StateMachineConfig<
  IssueWorkflowState,
  IssueWorkflowContext,
  WorkflowEvent
> = {
  initialState: 'analyzing',
  errorState: 'failed',
  nodes: [
    new AnalyzeIssueNode('analyzing'),
    new GeneratePlanNode('planning'),
    new ImplementIssueNode('implementing'),
    new TestImplementationNode('testing'),
    new CreatePRNode('creating_pr'),
    new IssueCompleteNode('complete'),
    new IssueFailedNode('failed'),
  ],
};

export function createIssueWorkflow(
  context: IssueWorkflowContext,
  persistence: any
): StateMachine<IssueWorkflowState, IssueWorkflowContext, WorkflowEvent> {
  return new StateMachine(
    issueWorkflowConfig,
    persistence,
    context,
    `issue-${context.workflowId}`,
    {
      onTransition: async (from, to, context) => {
        console.log(`Issue workflow ${context.workflowId}: ${from} → ${to}`);
      },
      onError: async (error, store) => {
        console.error(`Issue workflow error:`, error);
        await store.context.store.updateWorkflow(store.context.workflowId, {
          error: error.message,
        });
        return { status: 'transition', to: 'failed' };
      },
    }
  );
}
