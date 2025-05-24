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

export function createIssueWorkflowConfig(
  octokit: any
): StateMachineConfig<IssueWorkflowState, IssueWorkflowContext, WorkflowEvent> {
  return {
    initialState: 'analyzing',
    errorState: 'failed',
    nodes: [
      new AnalyzeIssueNode('analyzing'),
      new GeneratePlanNode('planning'),
      new ImplementIssueNode('implementing'),
      new TestImplementationNode('testing'),
      new CreatePRNode('creating_pr', octokit),
      new IssueCompleteNode('complete'),
      new IssueFailedNode('failed'),
    ],
  };
}

export function createIssueWorkflow(
  context: IssueWorkflowContext,
  persistence: any
): StateMachine<IssueWorkflowState, IssueWorkflowContext, WorkflowEvent> {
  const config = createIssueWorkflowConfig(context.octokit);
  return new StateMachine(
    config,
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
