import type { EnrichedAnalysis } from '../analysis/types.js';
import type { PlanStep, PlanContext, PlanStrategy } from './types.js';
import { log } from '../../logging.js';

export class FeatureStrategy implements PlanStrategy {
  name = 'feature';

  canHandle(analysis: EnrichedAnalysis): boolean {
    return analysis.type === 'feature';
  }

  async generateSteps(analysis: EnrichedAnalysis, context: PlanContext): Promise<PlanStep[]> {
    const steps: PlanStep[] = [];
    const complexity = this.estimateComplexity(analysis);

    // 1. Design phase (if complex)
    if (complexity === 'high' || analysis.requirements.length > 3) {
      steps.push({
        title: 'Design feature architecture',
        description: `Design the architecture and API for: ${analysis.requirements[0].description}`,
        acceptance_criteria: [
          'Architecture documented in comments or design doc',
          'API interfaces defined',
          'Integration points identified',
        ],
        technical_notes: 'Consider existing patterns in the codebase',
        estimated_complexity: 'medium',
        context_files: context.relevantFiles.filter(f => f.relevance === 'core').map(f => f.path),
      });
    }

    // 2. Implementation phase
    const implSteps = this.createImplementationSteps(analysis, context);
    steps.push(...implSteps);

    // 3. Testing phase
    steps.push({
      title: 'Add comprehensive tests',
      description: 'Write unit and integration tests for the new feature',
      acceptance_criteria: [
        'Unit tests for all new functions/methods',
        'Integration tests for feature workflows',
        'All tests passing',
        'Good code coverage (>80%)',
      ],
      technical_notes: 'Follow existing test patterns',
      estimated_complexity: 'medium',
      dependencies: implSteps.map((s, i) => `step-${i + (complexity === 'high' ? 2 : 1)}`),
      context_files: context.tests.map(t => t.file),
    });

    // 4. Documentation phase
    steps.push({
      title: 'Update documentation',
      description: 'Document the new feature in README and/or API docs',
      acceptance_criteria: [
        'Feature documented in appropriate location',
        'Usage examples provided',
        'API reference updated if applicable',
      ],
      technical_notes: 'Keep documentation concise and example-driven',
      estimated_complexity: 'low',
      dependencies: [`step-${steps.length}`],
      context_files: context.documentation,
    });

    return steps;
  }

  private estimateComplexity(analysis: EnrichedAnalysis): 'low' | 'medium' | 'high' {
    const fileCount = analysis.technicalScope.affectedFiles.length;
    const reqCount = analysis.requirements.length;
    
    if (fileCount > 10 || reqCount > 5) return 'high';
    if (fileCount > 5 || reqCount > 3) return 'medium';
    return 'low';
  }

  private createImplementationSteps(analysis: EnrichedAnalysis, context: PlanContext): PlanStep[] {
    const steps: PlanStep[] = [];
    
    // Group requirements by affected files
    const fileGroups = this.groupRequirementsByFiles(analysis);
    
    for (const [files, requirements] of fileGroups.entries()) {
      const fileList = Array.from(files);
      steps.push({
        title: `Implement ${requirements[0].description.substring(0, 50)}...`,
        description: requirements.map(r => r.description).join('\n'),
        acceptance_criteria: requirements.flatMap(r => r.acceptanceCriteria || [
          `Requirement "${r.description}" is implemented`,
          'Code compiles without errors',
          'Follows project conventions',
        ]),
        technical_notes: analysis.suggestedApproach,
        estimated_complexity: this.estimateStepComplexity(requirements),
        context_files: [...fileList, ...context.examples.map(e => e.file)],
        rmfilter_args: ['--with-imports', ...fileList],
      });
    }
    
    return steps;
  }

  private groupRequirementsByFiles(analysis: EnrichedAnalysis): Map<Set<string>, typeof analysis.requirements> {
    const groups = new Map<Set<string>, typeof analysis.requirements>();
    
    // Simple grouping - in reality would be more sophisticated
    const filesSet = new Set(analysis.technicalScope.affectedFiles);
    groups.set(filesSet, analysis.requirements);
    
    return groups;
  }

  private estimateStepComplexity(requirements: any[]): 'low' | 'medium' | 'high' {
    if (requirements.length > 3) return 'high';
    if (requirements.length > 1) return 'medium';
    return 'low';
  }
}

export class BugFixStrategy implements PlanStrategy {
  name = 'bug';

  canHandle(analysis: EnrichedAnalysis): boolean {
    return analysis.type === 'bug';
  }

  async generateSteps(analysis: EnrichedAnalysis, context: PlanContext): Promise<PlanStep[]> {
    const steps: PlanStep[] = [];

    // 1. Reproduce/understand bug
    steps.push({
      title: 'Reproduce and understand the bug',
      description: `Reproduce the reported issue: ${analysis.requirements[0]?.description || 'Bug'}`,
      acceptance_criteria: [
        'Bug can be consistently reproduced',
        'Root cause identified',
        'Reproduction steps documented',
      ],
      technical_notes: 'Create minimal reproduction if possible',
      estimated_complexity: 'medium',
      context_files: analysis.technicalScope.affectedFiles,
    });

    // 2. Implement fix
    steps.push({
      title: 'Implement bug fix',
      description: 'Fix the root cause of the bug',
      acceptance_criteria: [
        'Bug no longer reproducible',
        'Fix does not break existing functionality',
        'Code follows project patterns',
      ],
      technical_notes: analysis.suggestedApproach || 'Ensure minimal changes',
      estimated_complexity: 'medium',
      dependencies: ['step-1'],
      context_files: [
        ...analysis.technicalScope.affectedFiles,
        ...context.relevantFiles.filter(f => f.relevance === 'core').map(f => f.path),
      ],
      rmfilter_args: ['--with-imports', ...analysis.technicalScope.affectedFiles],
    });

    // 3. Add regression tests
    steps.push({
      title: 'Add regression tests',
      description: 'Add tests to prevent the bug from reoccurring',
      acceptance_criteria: [
        'Test reproduces the bug when fix is reverted',
        'Test passes with fix applied',
        'Test is clear and maintainable',
      ],
      technical_notes: 'Place test near related tests',
      estimated_complexity: 'low',
      dependencies: ['step-2'],
      context_files: context.tests.map(t => t.file),
    });

    // 4. Verify fix
    steps.push({
      title: 'Verify fix and run all tests',
      description: 'Ensure the fix works and doesn\'t break anything',
      acceptance_criteria: [
        'All existing tests pass',
        'Bug fix verified in different scenarios',
        'No performance regressions',
      ],
      technical_notes: 'Run full test suite',
      estimated_complexity: 'low',
      dependencies: ['step-3'],
      parallel: false,
    });

    return steps;
  }
}

export class RefactorStrategy implements PlanStrategy {
  name = 'refactor';

  canHandle(analysis: EnrichedAnalysis): boolean {
    return analysis.type === 'refactor';
  }

  async generateSteps(analysis: EnrichedAnalysis, context: PlanContext): Promise<PlanStep[]> {
    const steps: PlanStep[] = [];

    // 1. Analyze current implementation
    steps.push({
      title: 'Analyze current implementation',
      description: 'Understand the current code structure and identify refactoring needs',
      acceptance_criteria: [
        'Current implementation documented',
        'Pain points identified',
        'Refactoring approach planned',
      ],
      technical_notes: 'Create a clear plan before making changes',
      estimated_complexity: 'low',
      context_files: analysis.technicalScope.affectedFiles,
    });

    // 2. Ensure test coverage
    steps.push({
      title: 'Ensure adequate test coverage',
      description: 'Add tests if needed to safely refactor',
      acceptance_criteria: [
        'Critical paths have test coverage',
        'Tests pass with current implementation',
        'Tests will catch regressions',
      ],
      technical_notes: 'Tests are crucial for safe refactoring',
      estimated_complexity: 'medium',
      dependencies: ['step-1'],
      context_files: context.tests.map(t => t.file),
    });

    // 3. Implement refactoring incrementally
    const refactoringSteps = this.createIncrementalRefactoringSteps(analysis, context);
    steps.push(...refactoringSteps);

    // 4. Clean up and optimize
    steps.push({
      title: 'Clean up and optimize',
      description: 'Final cleanup, remove dead code, optimize imports',
      acceptance_criteria: [
        'No dead code remains',
        'Imports optimized',
        'Code properly formatted',
        'All tests still pass',
      ],
      technical_notes: 'Use linting and formatting tools',
      estimated_complexity: 'low',
      dependencies: refactoringSteps.map((s, i) => `step-${i + 3}`),
    });

    return steps;
  }

  private createIncrementalRefactoringSteps(
    analysis: EnrichedAnalysis, 
    context: PlanContext
  ): PlanStep[] {
    // Break down refactoring into safe, incremental steps
    const steps: PlanStep[] = [];
    const mainStep = {
      title: 'Refactor code structure',
      description: analysis.requirements.map(r => r.description).join('\n'),
      acceptance_criteria: [
        'Code structure improved',
        'All tests pass after each change',
        'No behavior changes',
        'Code is more maintainable',
      ],
      technical_notes: 'Make incremental changes, test after each',
      estimated_complexity: 'high' as const,
      dependencies: ['step-2'],
      context_files: [
        ...analysis.technicalScope.affectedFiles,
        ...analysis.technicalScope.suggestedFiles,
      ],
      rmfilter_args: ['--with-all-imports', ...analysis.technicalScope.affectedFiles],
    };
    
    steps.push(mainStep);
    return steps;
  }
}

export class DocumentationStrategy implements PlanStrategy {
  name = 'documentation';

  canHandle(analysis: EnrichedAnalysis): boolean {
    return analysis.type === 'documentation';
  }

  async generateSteps(analysis: EnrichedAnalysis, context: PlanContext): Promise<PlanStep[]> {
    const steps: PlanStep[] = [];

    // 1. Analyze documentation needs
    steps.push({
      title: 'Analyze documentation requirements',
      description: 'Understand what documentation is needed and where',
      acceptance_criteria: [
        'Documentation gaps identified',
        'Target audience defined',
        'Documentation structure planned',
      ],
      technical_notes: 'Consider existing documentation patterns',
      estimated_complexity: 'low',
      context_files: context.documentation,
    });

    // 2. Write/update documentation
    steps.push({
      title: 'Write or update documentation',
      description: analysis.requirements.map(r => r.description).join('\n'),
      acceptance_criteria: [
        'Documentation is clear and accurate',
        'Examples are working and tested',
        'Formatting follows project standards',
      ],
      technical_notes: 'Keep it concise and user-focused',
      estimated_complexity: 'medium',
      dependencies: ['step-1'],
      context_files: [
        ...analysis.technicalScope.affectedFiles,
        ...context.documentation,
      ],
    });

    // 3. Add examples if needed
    if (analysis.requirements.some(r => 
      r.description.toLowerCase().includes('example') || 
      r.description.toLowerCase().includes('tutorial')
    )) {
      steps.push({
        title: 'Add code examples',
        description: 'Create working examples to illustrate usage',
        acceptance_criteria: [
          'Examples are complete and runnable',
          'Examples cover common use cases',
          'Examples are well-commented',
        ],
        technical_notes: 'Test examples to ensure they work',
        estimated_complexity: 'medium',
        dependencies: ['step-2'],
        context_files: context.examples.map(e => e.file),
      });
    }

    // 4. Update related docs
    steps.push({
      title: 'Update related documentation',
      description: 'Update any related docs, READMEs, or API references',
      acceptance_criteria: [
        'All related docs are consistent',
        'No broken links',
        'Version info updated if needed',
      ],
      technical_notes: 'Check for references that need updating',
      estimated_complexity: 'low',
      dependencies: steps.slice(1).map((s, i) => `step-${i + 2}`),
      context_files: context.documentation,
    });

    return steps;
  }
}

export class TestStrategy implements PlanStrategy {
  name = 'test';

  canHandle(analysis: EnrichedAnalysis): boolean {
    return analysis.type === 'test';
  }

  async generateSteps(analysis: EnrichedAnalysis, context: PlanContext): Promise<PlanStep[]> {
    const steps: PlanStep[] = [];

    // 1. Identify test gaps
    steps.push({
      title: 'Identify testing gaps',
      description: 'Analyze current test coverage and identify what needs testing',
      acceptance_criteria: [
        'Test coverage report generated',
        'Untested code paths identified',
        'Test strategy documented',
      ],
      technical_notes: 'Use coverage tools if available',
      estimated_complexity: 'low',
      context_files: [
        ...analysis.technicalScope.affectedFiles,
        ...context.tests.map(t => t.file),
      ],
    });

    // 2. Write unit tests
    steps.push({
      title: 'Write unit tests',
      description: 'Add unit tests for untested functions and edge cases',
      acceptance_criteria: [
        'All public functions have tests',
        'Edge cases covered',
        'Tests are isolated and fast',
        'Tests follow project patterns',
      ],
      technical_notes: 'Focus on testing behavior, not implementation',
      estimated_complexity: 'medium',
      dependencies: ['step-1'],
      context_files: context.tests.filter(t => t.type === 'unit').map(t => t.file),
      rmfilter_args: ['--with-imports', ...analysis.technicalScope.affectedFiles],
    });

    // 3. Add integration tests if needed
    if (analysis.requirements.some(r => 
      r.description.toLowerCase().includes('integration') ||
      r.description.toLowerCase().includes('e2e')
    )) {
      steps.push({
        title: 'Add integration tests',
        description: 'Write tests for component interactions and workflows',
        acceptance_criteria: [
          'Key workflows have integration tests',
          'Tests cover realistic scenarios',
          'Tests are maintainable',
        ],
        technical_notes: 'Balance thoroughness with execution time',
        estimated_complexity: 'high',
        dependencies: ['step-2'],
        context_files: context.tests.filter(t => t.type === 'integration').map(t => t.file),
      });
    }

    // 4. Verify coverage improvement
    steps.push({
      title: 'Verify test coverage improvement',
      description: 'Ensure test coverage has improved and meets targets',
      acceptance_criteria: [
        'Coverage increased from baseline',
        'No critical paths left untested',
        'Coverage report shows improvement',
      ],
      technical_notes: 'Document coverage metrics',
      estimated_complexity: 'low',
      dependencies: steps.slice(1).map((s, i) => `step-${i + 2}`),
    });

    return steps;
  }
}

// Factory to get the right strategy
export class StrategyFactory {
  private strategies: PlanStrategy[] = [
    new FeatureStrategy(),
    new BugFixStrategy(),
    new RefactorStrategy(),
    new DocumentationStrategy(),
    new TestStrategy(),
  ];

  getStrategy(analysis: EnrichedAnalysis): PlanStrategy {
    const strategy = this.strategies.find(s => s.canHandle(analysis));
    if (!strategy) {
      log(`No specific strategy for type ${analysis.type}, using feature strategy`);
      return new FeatureStrategy();
    }
    return strategy;
  }
}