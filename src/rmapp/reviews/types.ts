import type { Octokit } from 'octokit';

export interface CodeLocation {
  file: string;
  startLine: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
}

export interface ReviewThread {
  id: string;
  comments: ReviewComment[];
  resolved: boolean;
  originalComment: ReviewComment;
}

export interface ReviewComment {
  id: number;
  type: 'inline' | 'general' | 'suggestion';
  body: string;
  location?: CodeLocation;
  thread?: ReviewThread;
  author: string;
  createdAt: Date;
  resolved: boolean;
  path?: string;
  line?: number;
  side?: 'LEFT' | 'RIGHT';
  diffHunk?: string;
}

export interface ParsedReview {
  comment: ReviewComment;
  intent: ReviewIntent;
  changeRequests: ChangeRequest[];
  questions: Question[];
  context: ReviewContext;
  locations: CodeLocation[];
}

export interface ChangeRequest {
  type: 'add' | 'modify' | 'remove' | 'refactor';
  description: string;
  location?: CodeLocation;
  priority: 'required' | 'suggested' | 'optional';
  suggestedCode?: string;
  rationale?: string;
  changeType?: ChangeType;
  complexity?: 'low' | 'medium' | 'high';
  estimatedLOC?: number;
}

export interface Question {
  text: string;
  topic: string;
  needsResponse: boolean;
}

export enum ReviewIntent {
  RequestChanges = 'request_changes',
  Suggestion = 'suggestion',
  Question = 'question',
  Approval = 'approval',
  Comment = 'comment',
}

export type ChangeType = 
  | 'errorHandling'
  | 'validation'
  | 'logging'
  | 'testing'
  | 'documentation'
  | 'refactoring'
  | 'performance'
  | 'security'
  | 'general';

export interface ReviewContext {
  comment: ReviewComment;
  diff?: string;
  files: FileContent[];
  thread?: ReviewThread;
  prContext: PullRequestContext;
  commits: CommitInfo[];
  metadata: {
    prNumber: number;
    author: string;
    timestamp: Date;
  };
}

export interface FileContent {
  path: string;
  content: string;
  language?: string;
}

export interface PullRequestContext {
  number: number;
  title: string;
  body: string;
  base: string;
  head: string;
  draft: boolean;
  labels: string[];
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  timestamp: Date;
}

export interface TextReference {
  type: 'symbol' | 'file' | 'line' | 'function' | 'class';
  value: string;
  context?: string;
}

export interface AnalyzedChange extends ChangeRequest {
  changeType: ChangeType;
  complexity: 'low' | 'medium' | 'high';
  patterns: CodePattern[];
  approach: ImplementationApproach;
  estimatedLOC: number;
}

export interface CodePattern {
  name: string;
  description: string;
  example?: string;
  files: string[];
}

export interface ImplementationApproach {
  steps: string[];
  considerations: string[];
  risks: string[];
  alternatives?: string[];
}

export interface GroupedReviews {
  byFile: Map<string, ParsedReview[]>;
  byType: Map<ChangeType, ParsedReview[]>;
  byPriority: Map<string, ParsedReview[]>;
  byAuthor: Map<string, ParsedReview[]>;
}

export interface PrioritizedGroups {
  required: ParsedReview[];
  suggested: ParsedReview[];
  optional: ParsedReview[];
  questions: ParsedReview[];
}

export interface GitHubSuggestion {
  id: number;
  body: string;
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
}

export interface ParsedSuggestion {
  suggestedCode: string;
  startLine: number;
  endLine?: number;
  originalCode?: string;
}

export interface ProcessedSuggestion {
  original: GitHubSuggestion;
  parsed: ParsedSuggestion | null;
  validation: SuggestionValidation;
  enhanced?: EnhancedSuggestion;
  canAutoApply: boolean;
}

export interface SuggestionValidation {
  isValid: boolean;
  hasConflicts: boolean;
  errors: string[];
  warnings: string[];
}

export interface EnhancedSuggestion extends ParsedSuggestion {
  impact: 'low' | 'medium' | 'high';
  affectedSymbols: string[];
  requiresImports?: string[];
}

export interface ParsedReviewSet {
  reviews: ParsedReview[];
  grouped: PrioritizedGroups;
  summary: ReviewSummary;
}

export interface ReviewSummary {
  totalComments: number;
  actionableComments: number;
  requiredChanges: number;
  suggestions: number;
  questions: number;
  approvals: number;
  filesAffected: string[];
  estimatedWorkHours: number;
}