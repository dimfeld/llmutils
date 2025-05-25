export interface BatchOperation {
  id: string;
  type: 'issue_implementation' | 'pr_review' | 'mixed';
  items: BatchItem[];
  options: BatchOptions;
  status: BatchStatus;
  progress: BatchProgress;
  results: BatchResults;
}

export interface BatchItem {
  id: string;
  type: 'issue' | 'pr' | 'review';
  reference: string | number;
  dependencies?: string[];
  priority: number;
  status: ItemStatus;
  result?: ItemResult;
  workspaceId?: string;
  startTime?: number;
  endTime?: number;
}

export type ItemStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type BatchStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface BatchOptions {
  concurrency: number;
  stopOnError: boolean;
  timeout?: number;
  retryPolicy?: RetryPolicy;
  resourceLimits?: ResourceLimits;
  isRecovery?: boolean;
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMultiplier: number;
  initialDelay: number;
  maxDelay: number;
  retryableErrors?: string[];
}

export interface ResourceLimits {
  maxApiCalls?: number;
  maxMemoryUsage?: number;
  maxWorkspaces?: number;
}

export interface BatchProgress {
  total: number;
  completed: number;
  failed: number;
  running: number;
  skipped: number;
  startTime: Date;
  estimatedCompletion?: Date;
}

export interface ItemResult {
  summary: string;
  details?: any;
  duration?: number;
  error?: string;
  workspace?: string;
  commits?: string[];
  artifacts?: ResultArtifact[];
}

export interface ResultArtifact {
  type: 'pr' | 'commit' | 'comment' | 'file';
  reference: string;
  url?: string;
  description?: string;
}

export interface BatchResults {
  successful: SuccessfulItem[];
  failed: FailedItem[];
  skipped: SkippedItem[];
  summary: BatchSummary;
}

export interface SuccessfulItem {
  item: BatchItem;
  result: ItemResult;
  duration: number;
}

export interface FailedItem {
  item: BatchItem;
  error: string;
  canRetry: boolean;
  failureReason?: 'timeout' | 'error' | 'dependency_failed' | 'resource_limit';
}

export interface SkippedItem {
  item: BatchItem;
  reason: string;
}

export interface BatchSummary {
  totalItems: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;
  duration: number;
  byType: Map<string, TypeSummary>;
  resourceUsage?: ResourceUsage;
}

export interface TypeSummary {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  avgDuration?: number;
}

export interface ResourceUsage {
  apiCalls: number;
  peakMemory: number;
  workspacesUsed: number;
}

export interface Resources {
  workspace: string;
  apiQuota: number;
  release: () => Promise<void>;
}

export interface ScheduledItem {
  item: BatchItem;
  level: number;
  priority: number;
  batch: string;
}

export interface RunningItem {
  item: BatchItem;
  resources: Resources;
  startTime: number;
  timeout?: NodeJS.Timeout;
}

export type ProgressEvent = 'start' | 'progress' | 'complete' | 'error';
export type ProgressListener = (event: ProgressEvent, progress: BatchProgress) => void;

export interface WorkspaceInfo {
  id: string;
  path: string;
  inUse: boolean;
  lastUsed: Date;
  branch?: string;
}