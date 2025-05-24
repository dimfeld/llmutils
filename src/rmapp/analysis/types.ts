import type { WebhookEvent } from '../types.js';

export interface IssueAnalysis {
  type: 'feature' | 'bug' | 'refactor' | 'documentation' | 'test' | 'other';
  requirements: Requirement[];
  technicalScope: TechnicalScope;
  references: References;
  suggestedApproach?: string;
  confidence: number; // 0-1 confidence score
}

export interface Requirement {
  id: string;
  description: string;
  priority: 'must' | 'should' | 'could';
  acceptanceCriteria?: string[];
}

export interface TechnicalScope {
  affectedFiles: string[];
  suggestedFiles: string[];
  relatedPatterns: string[];
  dependencies: string[];
}

export interface References {
  files: FileReference[];
  issues: IssueReference[];
  prs: PRReference[];
  documentation: DocReference[];
  codeSnippets: CodeSnippet[];
}

export interface FileReference {
  path: string;
  line?: number;
  reason: string;
}

export interface IssueReference {
  number: number;
  url: string;
  title?: string;
  state?: 'open' | 'closed';
}

export interface PRReference {
  number: number;
  url: string;
  title?: string;
  state?: 'open' | 'closed' | 'merged';
}

export interface DocReference {
  url: string;
  title?: string;
  type: 'internal' | 'external';
}

export interface CodeSnippet {
  language: string;
  code: string;
  description?: string;
}

export interface ParsedIssue {
  title: string;
  body: string;
  sections: Map<string, string>;
  codeBlocks: CodeSnippet[];
  links: string[];
  mentions: string[];
}

export interface Pattern {
  type: 'implementation' | 'architecture' | 'testing';
  description: string;
  examples: string[];
  relevance: number; // 0-1
}

export interface ImplementationSuggestion {
  approach: string;
  steps: string[];
  patterns: Pattern[];
  potentialChallenges: string[];
  estimatedComplexity: 'low' | 'medium' | 'high';
}

export interface EnrichedAnalysis extends IssueAnalysis {
  codebaseContext: CodebaseContext;
  relatedChanges: RelatedChange[];
  conventions: Convention[];
  patterns?: Pattern[];
  issueNumber?: number;
}

export interface CodebaseContext {
  primaryLanguages: string[];
  frameworks: string[];
  architectureStyle: string;
  testingApproach: string;
}

export interface RelatedChange {
  commit: string;
  pr?: number;
  description: string;
  files: string[];
  relevance: number;
}

export interface Convention {
  type: 'naming' | 'structure' | 'pattern' | 'style';
  description: string;
  examples: string[];
}

export interface RepoContext {
  owner: string;
  repo: string;
  defaultBranch: string;
  workDir: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  html_url: string;
  user: {
    login: string;
  };
  labels: Array<{
    name: string;
  }>;
  created_at: string;
  updated_at: string;
}