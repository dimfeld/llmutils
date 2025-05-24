import type { PlanSchema } from '../../rmplan/planSchema';

export interface PRTemplate {
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number;
  draft?: boolean;
}

export interface PRTemplateContext {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  analysis: any;
  plan: PlanSchema;
  branchName: string;
  baseRef: string;
}

export interface ChangeAnalysis {
  filesChanged: number;
  insertions: number;
  deletions: number;
  testsCoverage: {
    hasTests: boolean;
    testFiles: string[];
    coveragePercentage?: number;
  };
  breaking: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  affectedAreas: string[];
}

export interface PRContext {
  owner: string;
  repo: string;
  issueNumber: number;
  branchName: string;
  baseRef: string;
}

export interface PRCreationResult {
  success: boolean;
  prNumber?: number;
  prUrl?: string;
  error?: string;
}

export interface CommitStrategy {
  groupByFeature: boolean;
  maxCommitsPerPR: number;
  squashMerge: boolean;
}

export interface ReviewChecklistItem {
  checked: boolean;
  description: string;
  category: 'testing' | 'documentation' | 'code-quality' | 'security' | 'performance';
}

export interface PRMetadata {
  issueNumber: number;
  workflowId: string;
  planPath: string;
  completedSteps: string[];
  generatedBy: 'rmapp';
  version: string;
}