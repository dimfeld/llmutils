import type { BaseEvent } from '../../state_machine/events.js';
import type { WebhookEvent } from '../types.js';
import type { Workflow } from '../state/models.js';
import type { Octokit } from 'octokit';
import type { StateStore } from '../state/store.js';

// Workflow Events
export interface WorkflowStartEvent extends BaseEvent {
  type: 'workflow_start';
  workflowId: string;
  workflowType: 'issue' | 'pr_review';
  timestamp: number;
}

export interface WorkflowStepCompleteEvent extends BaseEvent {
  type: 'workflow_step_complete';
  step: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface WorkflowRetryEvent extends BaseEvent {
  type: 'workflow_retry';
  step: string;
  attempt: number;
  timestamp: number;
}

export interface WorkflowErrorEvent extends BaseEvent {
  type: 'workflow_error';
  step: string;
  error: string;
  recoverable: boolean;
  timestamp: number;
}

export interface WorkflowCancelEvent extends BaseEvent {
  type: 'workflow_cancel';
  reason: string;
  timestamp: number;
}

export type WorkflowEvent =
  | WorkflowStartEvent
  | WorkflowStepCompleteEvent
  | WorkflowRetryEvent
  | WorkflowErrorEvent
  | WorkflowCancelEvent;

// Workflow Context
export interface WorkflowContext {
  workflowId: string;
  octokit: Octokit;
  store: StateStore;
  webhookEvent: WebhookEvent;
  workspaceDir?: string;
  artifacts: Map<string, any>;
}

export interface IssueWorkflowContext extends WorkflowContext {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  analysis?: IssueAnalysis;
  planPath?: string;
  branchName?: string;
  prNumber?: number;
}

export interface PRReviewWorkflowContext extends WorkflowContext {
  prNumber: number;
  prTitle: string;
  reviewComments: ReviewComment[];
  changesByFile: Map<string, CodeChange[]>;
}

// Analysis Results
export interface IssueAnalysis {
  requirements: string[];
  affectedFiles: string[];
  suggestedApproach: string;
  complexity: 'simple' | 'medium' | 'complex';
  tags: string[];
}

export interface ReviewComment {
  id: number;
  body: string;
  path?: string;
  line?: number;
  action: 'change_requested' | 'suggestion' | 'question' | 'approval';
  parsedInstruction?: string;
}

export interface CodeChange {
  file: string;
  line?: number;
  change: string;
  type: 'add' | 'modify' | 'delete';
}

// Node execution results
export interface NodeExecutionResult {
  success: boolean;
  error?: string;
  artifacts?: Record<string, any>;
}

// Workflow configuration
export interface WorkflowConfig {
  maxRetries: number;
  retryDelayMs: number;
  timeoutMs: number;
  model?: string;
}
