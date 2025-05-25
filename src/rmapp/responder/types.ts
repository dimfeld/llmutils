import type { ReviewComment, CodeLocation, ChangeType, ChangeRequest, ParsedReview } from '../reviews/types.js';

export interface ReviewResponse {
  comment: ReviewComment;
  action: ResponseAction;
  changes?: AppliedChange[];
  message: string;
  status: 'success' | 'partial' | 'failed';
  details?: ResponseDetails;
  summary?: string;
}

export interface AppliedChange {
  file: string;
  diff: string;
  description: string;
  type: ChangeType;
  location: CodeLocation;
}

export interface ResponseAction {
  type: 'change' | 'reply' | 'clarification' | 'decline';
  reason?: string;
  requiresApproval?: boolean;
}

export interface ResponseDetails {
  codeSnippet?: string;
  validatedFields?: string[];
  loggedEvents?: string[];
  testedFunctions?: string[];
  refactoringDescription?: string;
  language?: string;
  errors?: string[];
}

export interface BatchResponse {
  responses: ReviewResponse[];
  commit?: CommitInfo;
  summary: BatchSummary;
}

export interface CommitInfo {
  sha: string;
  message: string;
  files: string[];
  stats: CommitStats;
}

export interface CommitStats {
  additions: number;
  deletions: number;
  files: number;
}

export interface BatchSummary {
  total: number;
  successful: number;
  partial: number;
  failed: number;
  clarifications: number;
  filesModified: string[];
  changesByType: Map<ChangeType, number>;
}

export interface ChangeResult {
  status: 'success' | 'partial' | 'failed';
  changes: AppliedChange[];
  details: ResponseDetails;
  language?: string;
  commit?: CommitInfo;
  changeType: ChangeType;
  changeDescription?: string;
}

export interface ResponseOptions {
  autoCommit?: boolean;
  batchSize?: number;
  skipClarifications?: boolean;
  dryRun?: boolean;
  workspace?: string;
  model?: string;
}

export interface ResponseResult {
  responses: ReviewResponse[];
  commits: CommitInfo[];
  summary: BatchSummary;
  errors: Error[];
}

export interface ClarificationReason {
  ambiguousLocation?: boolean;
  unclearRequest?: boolean;
  needsExample?: boolean;
  conflictingRequests?: boolean;
  missingContext?: boolean;
}

export interface AnalyzedChange extends ChangeRequest {
  originalComment: string;
  confidence: number;
}

export interface PullRequest {
  owner: string;
  repo: string;
  number: number;
  workspace: string;
  baseBranch: string;
  headBranch: string;
}