import type { 
  PlanStep, 
  StepConfig, 
  TestingRequirements,
  PlanContext 
} from './types.js';
import type { Requirement, TechnicalScope } from '../analysis/types.js';
import { log } from '../../logging.js';

export class StepGenerator {
  generateImplementationSteps(
    requirements: Requirement[],
    scope: TechnicalScope,
    context: PlanContext
  ): PlanStep[] {
    // Group related requirements
    const groups = this.groupRelatedRequirements(requirements);
    
    // Order by dependencies
    const orderedGroups = this.orderByDependencies(groups, scope);
    
    // Create atomic steps
    const steps: PlanStep[] = [];
    for (const group of orderedGroups) {
      const step = this.createImplementationStep(group, scope, context);
      steps.push(step);
    }
    
    // Add verification steps
    steps.push(...this.addVerificationSteps(steps));
    
    return steps;
  }

  generateTestingSteps(
    implementation: PlanStep[],
    testingScope: TestingRequirements,
    context: PlanContext
  ): PlanStep[] {
    const steps: PlanStep[] = [];
    
    // Unit test steps
    if (testingScope.unitTestsNeeded) {
      steps.push(this.createUnitTestStep(implementation, testingScope, context));
    }
    
    // Integration test steps
    if (testingScope.integrationTestsNeeded) {
      steps.push(this.createIntegrationTestStep(implementation, testingScope, context));
    }
    
    // E2E test steps (if needed)
    if (testingScope.e2eTestsNeeded) {
      steps.push(this.createE2ETestStep(implementation, testingScope, context));
    }
    
    // Coverage verification
    if (testingScope.coverageTarget) {
      steps.push(this.createCoverageStep(testingScope));
    }
    
    return steps;
  }

  private groupRelatedRequirements(requirements: Requirement[]): Requirement[][] {
    // Simple grouping by priority for now
    const groups: Map<string, Requirement[]> = new Map();
    
    for (const req of requirements) {
      const key = req.priority;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(req);
    }
    
    // Return in priority order
    const orderedGroups: Requirement[][] = [];
    if (groups.has('must')) orderedGroups.push(groups.get('must')!);
    if (groups.has('should')) orderedGroups.push(groups.get('should')!);
    if (groups.has('could')) orderedGroups.push(groups.get('could')!);
    
    return orderedGroups;
  }

  private orderByDependencies(
    groups: Requirement[][], 
    scope: TechnicalScope
  ): Requirement[][] {
    // For now, just return as-is
    // In a real implementation, would analyze file dependencies
    return groups;
  }

  private createImplementationStep(
    requirements: Requirement[],
    scope: TechnicalScope,
    context: PlanContext
  ): PlanStep {
    const mainReq = requirements[0];
    const config: StepConfig = {
      title: this.generateStepTitle(requirements),
      description: this.generateStepDescription(requirements),
      criteria: this.generateAcceptanceCriteria(requirements),
      notes: this.generateTechnicalNotes(requirements, context),
      complexity: this.estimateComplexity(requirements, scope),
      files: this.selectRelevantFiles(requirements, scope, context),
    };
    
    return this.createStep(config);
  }

  private createStep(config: StepConfig): PlanStep {
    return {
      title: config.title,
      description: config.description,
      acceptance_criteria: config.criteria,
      technical_notes: config.notes,
      estimated_complexity: config.complexity,
      context_files: config.files,
      rmfilter_args: config.files ? ['--with-imports', ...config.files] : undefined,
    };
  }

  private generateStepTitle(requirements: Requirement[]): string {
    if (requirements.length === 1) {
      // Truncate to reasonable length
      const desc = requirements[0].description;
      return desc.length > 60 ? desc.substring(0, 57) + '...' : desc;
    }
    
    // Multiple requirements - generate summary
    const priority = requirements[0].priority;
    return `Implement ${requirements.length} ${priority} requirements`;
  }

  private generateStepDescription(requirements: Requirement[]): string {
    return requirements.map(r => `- ${r.description}`).join('\n');
  }

  private generateAcceptanceCriteria(requirements: Requirement[]): string[] {
    const criteria: string[] = [];
    
    // Add specific criteria from requirements
    for (const req of requirements) {
      if (req.acceptanceCriteria) {
        criteria.push(...req.acceptanceCriteria);
      } else {
        criteria.push(`${req.description} is implemented`);
      }
    }
    
    // Add general criteria
    criteria.push('Code compiles without errors');
    criteria.push('Follows project conventions');
    criteria.push('No regressions introduced');
    
    return [...new Set(criteria)]; // Remove duplicates
  }

  private generateTechnicalNotes(
    requirements: Requirement[], 
    context: PlanContext
  ): string {
    const notes: string[] = [];
    
    // Add pattern references
    if (context.patterns.length > 0) {
      notes.push(`Follow patterns from: ${context.patterns[0].description}`);
    }
    
    // Add specific technical guidance
    const hasAsync = requirements.some(r => 
      r.description.toLowerCase().includes('async') || 
      r.description.toLowerCase().includes('concurrent')
    );
    if (hasAsync) {
      notes.push('Ensure proper async/await usage and error handling');
    }
    
    const hasApi = requirements.some(r => 
      r.description.toLowerCase().includes('api') || 
      r.description.toLowerCase().includes('endpoint')
    );
    if (hasApi) {
      notes.push('Follow REST conventions and add proper validation');
    }
    
    return notes.join('. ');
  }

  private estimateComplexity(
    requirements: Requirement[], 
    scope: TechnicalScope
  ): 'low' | 'medium' | 'high' {
    // Factor in multiple aspects
    let score = 0;
    
    // Number of requirements
    score += requirements.length * 0.3;
    
    // Number of files
    score += Math.min(scope.affectedFiles.length * 0.2, 2);
    
    // Priority
    if (requirements.some(r => r.priority === 'must')) {
      score += 0.5;
    }
    
    // Dependencies
    score += Math.min(scope.dependencies.length * 0.2, 1);
    
    if (score < 1) return 'low';
    if (score < 2.5) return 'medium';
    return 'high';
  }

  private selectRelevantFiles(
    requirements: Requirement[],
    scope: TechnicalScope,
    context: PlanContext
  ): string[] {
    const files = new Set<string>();
    
    // Add affected files
    scope.affectedFiles.forEach(f => files.add(f));
    
    // Add core context files
    context.relevantFiles
      .filter(f => f.relevance === 'core')
      .forEach(f => files.add(f.path));
    
    // Add example files if implementing similar functionality
    if (context.examples.length > 0) {
      context.examples.slice(0, 2).forEach(e => files.add(e.file));
    }
    
    return Array.from(files);
  }

  private addVerificationSteps(implementationSteps: PlanStep[]): PlanStep[] {
    const steps: PlanStep[] = [];
    
    // Add build verification
    steps.push({
      title: 'Verify build and type checking',
      description: 'Ensure all code compiles and type checks pass',
      acceptance_criteria: [
        'Build completes successfully',
        'No TypeScript errors',
        'No linting errors',
      ],
      technical_notes: 'Run build and lint commands',
      estimated_complexity: 'low',
      dependencies: implementationSteps.map((s, i) => `step-${i + 1}`),
    });
    
    return steps;
  }

  private createUnitTestStep(
    implementation: PlanStep[],
    testingScope: TestingRequirements,
    context: PlanContext
  ): PlanStep {
    return {
      title: 'Write unit tests',
      description: 'Add unit tests for new functionality',
      acceptance_criteria: [
        'All new functions/methods have tests',
        'Edge cases are tested',
        'Tests are isolated and fast',
        'Tests follow project patterns',
      ],
      technical_notes: 'Use existing test patterns as examples',
      estimated_complexity: 'medium',
      dependencies: implementation.map((s, i) => `step-${i + 1}`),
      context_files: [
        ...testingScope.existingTests,
        ...context.tests.filter(t => t.type === 'unit').map(t => t.file),
      ],
    };
  }

  private createIntegrationTestStep(
    implementation: PlanStep[],
    testingScope: TestingRequirements,
    context: PlanContext
  ): PlanStep {
    return {
      title: 'Write integration tests',
      description: 'Add tests for component interactions',
      acceptance_criteria: [
        'Key workflows are tested',
        'External dependencies are properly mocked/handled',
        'Tests cover realistic scenarios',
      ],
      technical_notes: 'Balance coverage with test execution time',
      estimated_complexity: 'high',
      dependencies: [`step-${implementation.length + 1}`], // After unit tests
      context_files: context.tests.filter(t => t.type === 'integration').map(t => t.file),
    };
  }

  private createE2ETestStep(
    implementation: PlanStep[],
    testingScope: TestingRequirements,
    context: PlanContext
  ): PlanStep {
    return {
      title: 'Write end-to-end tests',
      description: 'Add E2E tests for critical user flows',
      acceptance_criteria: [
        'Critical paths have E2E coverage',
        'Tests are stable and not flaky',
        'Tests run in reasonable time',
      ],
      technical_notes: 'Focus on most important user journeys',
      estimated_complexity: 'high',
      dependencies: [`step-${implementation.length + 2}`], // After integration tests
      context_files: context.tests.filter(t => t.type === 'e2e').map(t => t.file),
    };
  }

  private createCoverageStep(testingScope: TestingRequirements): PlanStep {
    return {
      title: 'Verify test coverage',
      description: `Ensure test coverage meets target of ${testingScope.coverageTarget}%`,
      acceptance_criteria: [
        `Coverage is at least ${testingScope.coverageTarget}%`,
        'No critical paths left untested',
        'Coverage report generated',
      ],
      technical_notes: 'Use coverage tools to identify gaps',
      estimated_complexity: 'low',
      parallel: false,
    };
  }
}