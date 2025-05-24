export type WorkflowType = 'issue' | 'pr_review';
export type WorkflowStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface Workflow {
  id: string;
  type: WorkflowType;
  status: WorkflowStatus;
  repository: {
    owner: string;
    name: string;
  };
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, any>;
  error?: string;
}

export interface IssueWorkflow extends Workflow {
  type: 'issue';
  issueNumber: number;
  issueTitle: string;
  planPath?: string;
  workspaceId?: string;
  branchName?: string;
  prNumber?: number;
  steps: {
    analyzed: boolean;
    planGenerated: boolean;
    implemented: boolean;
    prCreated: boolean;
  };
}

export interface PRReviewWorkflow extends Workflow {
  type: 'pr_review';
  prNumber: number;
  prTitle: string;
  workspaceId?: string;
  reviewComments: ReviewComment[];
  steps: {
    commentsParsed: boolean;
    changesApplied: boolean;
    responded: boolean;
  };
}

export interface ReviewComment {
  id: number;
  body: string;
  path?: string;
  line?: number;
  action: 'change_requested' | 'suggestion' | 'question' | 'approval';
  resolved: boolean;
  response?: string;
}

export interface WorkspaceInfo {
  id: string;
  path: string;
  workflowId: string;
  status: 'active' | 'completed' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

export interface CommandExecution {
  id: string;
  workflowId: string;
  command: string;
  args: string[];
  options: Record<string, any>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output?: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
}

export interface WorkflowEvent {
  id: string;
  workflowId: string;
  type: 'status_changed' | 'step_completed' | 'error' | 'command_executed';
  payload: Record<string, any>;
  createdAt: Date;
}