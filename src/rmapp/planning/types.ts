import type { EnrichedAnalysis, Requirement, TechnicalScope, Pattern } from '../analysis/types.js';
import type { RmplanConfig } from '../../rmplan/configSchema.js';
import type { PlanSchema } from '../../rmplan/planSchema.js';

// Re-export for convenience
export type Plan = PlanSchema;

// This matches the actual rmplan schema structure
export interface RmplanStep {
  prompt: string;
  examples?: string[];
  done: boolean;
}

export interface RmplanTask {
  title: string;
  description: string;
  files: string[];
  include_imports?: boolean;
  include_importers?: boolean;
  examples?: string[];
  steps: RmplanStep[];
}

export interface PlanStep {
  title: string;
  description: string;
  acceptance_criteria: string[];
  technical_notes?: string;
  estimated_complexity: 'low' | 'medium' | 'high';
  dependencies?: string[]; // Step IDs this depends on
  parallel?: boolean; // Can run in parallel with other steps
  context_files?: string[];
  rmfilter_args?: string[];
}

export interface FormattedStep extends PlanStep {
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  order: number;
}

export interface PlanContext {
  relevantFiles: FileContext[];
  examples: CodeExample[];
  documentation: string[];
  tests: TestContext[];
  patterns: Pattern[];
}

export interface FileContext {
  path: string;
  purpose: string;
  relevance: 'core' | 'reference' | 'example';
}

export interface CodeExample {
  file: string;
  description: string;
  code?: string;
}

export interface TestContext {
  file: string;
  type: 'unit' | 'integration' | 'e2e';
  description: string;
}

export interface StepConfig {
  title: string;
  description: string;
  criteria: string[];
  notes?: string;
  complexity: 'low' | 'medium' | 'high';
  files?: string[];
}

export interface TestingRequirements {
  unitTestsNeeded: boolean;
  integrationTestsNeeded: boolean;
  e2eTestsNeeded: boolean;
  coverageTarget?: number;
  existingTests: string[];
}

export interface DependencyGraph {
  nodes: Map<string, PlanStep>;
  edges: Map<string, Set<string>>; // step -> dependencies
}

export interface GeneratedPlan {
  steps: PlanStep[];
  context: PlanContext;
  strategy: string;
  globalInstructions: string;
}

export interface PlanMetadata {
  title: string;
  description: string;
  issueNumber: number;
  issueUrl: string;
  generatedAt: Date;
  strategy: string;
}


export interface RmplanFile {
  goal: string;
  details: string;
  tasks: RmplanTask[];
  config?: Partial<RmplanConfig>;
  metadata?: Record<string, any>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  suggestions: string[];
}

export interface ExecutabilityResult {
  executable: boolean;
  issues: string[];
  estimatedDuration: number; // minutes
  fileAccessChecks: Array<{
    file: string;
    exists: boolean;
    readable: boolean;
  }>;
}

export interface PlanStrategy {
  name: string;
  canHandle(analysis: EnrichedAnalysis): boolean;
  generateSteps(analysis: EnrichedAnalysis, context: PlanContext): Promise<PlanStep[]>;
}