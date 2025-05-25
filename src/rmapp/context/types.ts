export interface Context {
  id: string;
  type: ContextType;
  source: ContextSource;
  content: any;
  metadata: ContextMetadata;
  relevance: number;
  timestamp: Date;
}

export enum ContextType {
  Code = 'code',
  Documentation = 'documentation', 
  Issue = 'issue',
  PullRequest = 'pull_request',
  Commit = 'commit',
  Discussion = 'discussion',
  Example = 'example',
  Pattern = 'pattern'
}

export interface ContextSource {
  type: 'file' | 'url' | 'api' | 'search';
  location: string;
  version?: string;
}

export interface ContextMetadata {
  language?: string;
  symbols?: string[];
  dependencies?: string[];
  author?: string;
  lastModified?: Date;
  quality?: number;
  isPinned?: boolean;
  tags?: string[];
  [key: string]: any;
}

export interface ContextQuery {
  keywords: string[];
  types?: ContextType[];
  timeRange?: DateRange;
  maxResults?: number;
  minRelevance?: number;
}

export interface DateRange {
  start?: Date;
  end?: Date;
}

export interface GatheredContext {
  query: ContextQuery;
  contexts: Context[];
  summary: ContextSummary;
  insights?: Insight[];
  recommendations: string[];
  metadata?: {
    totalSearched: number;
    totalRelevant: number;
    searchTime: number;
  };
}

export interface ContextSummary {
  totalContexts: number;
  byType: Map<ContextType, number>;
  averageRelevance: number;
  keySymbols: string[];
  keyPatterns: string[];
  coverage: number;
}

export interface CodeFile {
  path: string;
  content: string;
  language: string;
  size: number;
}

export interface CodeSection {
  code: string;
  startLine: number;
  endLine: number;
  symbols: string[];
  dependencies: string[];
}

export interface AggregatedContext {
  byType: Map<ContextType, Context[]>;
  symbols: Set<string>;
  patterns: Pattern[];
  examples: Example[];
  graph: KnowledgeGraph;
  insights: Insight[];
  summary: ContextSummary;
}

export interface Pattern {
  name: string;
  description: string;
  occurrences: number;
  contexts: string[]; // Context IDs
  confidence: number;
}

export interface Example {
  title: string;
  code: string;
  explanation: string;
  contextId: string;
  quality: number;
}

export interface Insight {
  type: 'pattern' | 'relationship' | 'coverage' | 'quality' | 'recommendation';
  title: string;
  description: string;
  importance: number;
  data?: any;
}

export interface KnowledgeGraph {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
}

export interface KnowledgeNode {
  id: string;
  type: ContextType;
  label: string;
  data: Context;
}

export interface KnowledgeEdge {
  from: string;
  to: string;
  type: RelationType;
  weight: number;
}

export enum RelationType {
  References = 'references',
  Implements = 'implements',
  Tests = 'tests',
  Documents = 'documents',
  Depends = 'depends',
  Similar = 'similar',
  Related = 'related'
}

export interface ContextRequest {
  keywords?: string[];
  types?: ContextType[];
  filters?: ContextFilter[];
  minRelevance?: number;
  skipCache?: boolean;
  limit?: number;
}

export interface ContextFilter {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'regex';
  value: any;
}

export interface SearchOptions {
  limit?: number;
  filters?: ContextFilter[];
  includeScores?: boolean;
  facets?: string[];
}

export interface SearchResult {
  query: ContextQuery;
  results: Context[];
  totalCount: number;
  facets?: Facet[];
  suggestions?: string[];
}

export interface Facet {
  name: string;
  values: FacetValue[];
}

export interface FacetValue {
  value: string;
  count: number;
  label: string;
}

export interface ScoredContext {
  context: Context;
  score: number;
}

export interface RecommendedContext {
  context: Context;
  reason: string;
  score: number;
  priority: number;
}

export interface Gap {
  type: 'missing_type' | 'low_coverage' | 'outdated' | 'quality';
  value: any;
  importance: number;
}

export interface ContextAnalysis {
  contexts: Context[];
  codeCoverage: number;
  documentationCoverage: number;
  testCoverage: number;
  averageAge: number;
  averageQuality: number;
  missingTypes: Set<ContextType>;
}

export interface ContextProvider {
  type: ContextType;
  priority: number;
  gather(query: ContextQuery): Promise<Context[]>;
  validate(context: Context): Promise<boolean>;
  refresh(context: Context): Promise<Context>;
}