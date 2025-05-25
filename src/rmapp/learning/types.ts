export interface LearningEvent {
  id: string;
  type: EventType;
  timestamp: Date;
  context: EventContext;
  action: Action;
  outcome: Outcome;
  feedback?: Feedback;
}

export interface EventContext {
  actionId?: string;
  actionType?: string;
  generatedCode?: string;
  fileChanges?: FileChange[];
  issue?: number;
  pr?: number;
  review?: ReviewContext;
  error?: ErrorContext;
  [key: string]: any;
}

export interface FileChange {
  file: string;
  additions: number;
  deletions: number;
  changes: string[];
}

export interface ReviewContext {
  pr: number;
  reviewer: string;
  comments: ReviewComment[];
}

export interface ReviewComment {
  id: string;
  body: string;
  path?: string;
  line?: number;
  severity?: 'info' | 'warning' | 'error';
}

export interface ErrorContext {
  type: string;
  message: string;
  stack?: string;
  recoveryAttempts: number;
}

export interface Action {
  id: string;
  type: ActionType;
  target: string;
  parameters: Record<string, any>;
  timestamp: Date;
}

export enum ActionType {
  GenerateCode = 'generate_code',
  ApplyChange = 'apply_change',
  RespondToReview = 'respond_to_review',
  CreatePR = 'create_pr',
  Commit = 'commit',
  RunTests = 'run_tests',
  FixError = 'fix_error'
}

export interface Outcome {
  success: boolean;
  duration: number;
  result?: any;
  error?: string;
  metrics?: OutcomeMetrics;
}

export interface OutcomeMetrics {
  linesChanged?: number;
  testsAdded?: number;
  testsPassed?: number;
  reviewsResolved?: number;
  buildStatus?: 'success' | 'failure';
}

export interface Feedback {
  id: string;
  eventId: string;
  userId: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  message?: string;
  suggestions?: string[];
  timestamp: Date;
}

export interface Pattern {
  id: string;
  type: PatternType;
  signature: PatternSignature;
  occurrences: number;
  confidence: number;
  examples: Example[];
  recommendations: string[];
  lastSeen: Date;
}

export enum PatternType {
  CodeStyle = 'code_style',
  ErrorHandling = 'error_handling',
  ReviewFeedback = 'review_feedback',
  ImplementationApproach = 'implementation_approach',
  TestingStrategy = 'testing_strategy',
  Communication = 'communication'
}

export interface PatternSignature {
  key: string;
  features: Record<string, any>;
  conditions?: Condition[];
}

export interface Condition {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'matches';
  value: any;
}

export interface Example {
  id: string;
  eventId: string;
  description: string;
  code?: string;
  context?: Record<string, any>;
}

export interface LearnedBehavior {
  id: string;
  trigger: Trigger;
  action: RecommendedAction;
  confidence: number;
  evidence: string[]; // Event IDs
  exceptions: Exception[];
  lastUpdated: Date;
}

export interface Trigger {
  type: TriggerType;
  conditions: Condition[];
  context?: Record<string, any>;
}

export enum TriggerType {
  IssueType = 'issue_type',
  ReviewComment = 'review_comment',
  ErrorType = 'error_type',
  FilePattern = 'file_pattern',
  TimeOfDay = 'time_of_day',
  UserPreference = 'user_preference'
}

export interface RecommendedAction {
  type: ActionType;
  parameters: Record<string, any>;
  description: string;
  expectedOutcome?: Outcome;
}

export interface Exception {
  condition: Condition;
  reason: string;
  examples: string[]; // Event IDs
}

export interface Preferences {
  codeStyle: CodeStylePreferences;
  communication: CommunicationPreferences;
  workflow: WorkflowPreferences;
  tools: ToolPreferences;
}

export interface CodeStylePreferences {
  indentation: 'spaces' | 'tabs';
  indentSize: number;
  quotes: 'single' | 'double';
  semicolons: boolean;
  trailingComma: boolean;
  lineLength: number;
  namingConventions: Record<string, string>;
  importOrder?: string[];
}

export interface CommunicationPreferences {
  prDescriptionStyle: 'detailed' | 'concise' | 'bullet-points';
  commitMessageStyle: 'conventional' | 'descriptive' | 'brief';
  reviewResponseStyle: 'immediate' | 'batched' | 'detailed';
  mentionStyle: 'minimal' | 'moderate' | 'frequent';
}

export interface WorkflowPreferences {
  autoCommit: boolean;
  commitGranularity: 'atomic' | 'logical' | 'feature';
  prDescription: 'minimal' | 'moderate' | 'detailed';
  testFirst: boolean;
  reviewResponseTime: 'immediate' | 'batched' | 'end-of-day';
  branchNaming?: string; // Pattern
}

export interface ToolPreferences {
  preferredLanguageModel?: string;
  preferredTestRunner?: string;
  preferredLinter?: string;
  preferredFormatter?: string;
  customTools?: Record<string, string>;
}

export interface Statistics {
  totalEvents: number;
  successRate: number;
  averageResponseTime: number;
  patternAccuracy: number;
  behaviorAccuracy: number;
  feedbackScore: number;
  improvementRate: number;
  lastUpdated: Date;
}

export interface LearningModel {
  id: string;
  patterns: Pattern[];
  behaviors: LearnedBehavior[];
  preferences: Preferences;
  statistics: Statistics;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export enum EventType {
  IssueImplementation = 'issue_implementation',
  ReviewResponse = 'review_response',
  CodeGeneration = 'code_generation',
  ErrorRecovery = 'error_recovery',
  UserFeedback = 'user_feedback',
  TestExecution = 'test_execution',
  Outcome = 'outcome'
}

export interface Decision {
  id: string;
  type: string;
  options: DecisionOption[];
  context: DecisionContext;
  constraints?: Constraint[];
}

export interface DecisionOption {
  id: string;
  action: Action;
  score: number;
  pros: string[];
  cons: string[];
}

export interface DecisionContext {
  issue?: number;
  pr?: number;
  files?: string[];
  previousAttempts?: number;
  urgency?: 'low' | 'medium' | 'high';
  [key: string]: any;
}

export interface Constraint {
  type: string;
  value: any;
  required: boolean;
}

export interface EnhancedDecision {
  original: Decision;
  enhanced: Decision;
  recommendations: Recommendation[];
  confidence: number;
  evidence?: Evidence[];
}

export interface Recommendation {
  type: 'pattern' | 'behavior' | 'preference';
  source: string;
  suggestion: string;
  confidence: number;
  examples?: Example[];
  evidence?: string[];
}

export interface Evidence {
  type: string;
  source: string;
  relevance: number;
  data: any;
}

export interface LearningInsights {
  insights: Insight[];
  recommendations: ImprovementRecommendation[];
}

export interface Insight {
  type: string;
  title: string;
  description: string;
  importance: number;
  data?: any;
}

export interface ImprovementRecommendation {
  area: string;
  suggestion: string;
  expectedImpact: number;
  effort: 'low' | 'medium' | 'high';
}