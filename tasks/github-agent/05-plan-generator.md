# Plan Generator

## Overview
Create a system that generates high-quality rmplan files from issue analysis, incorporating codebase patterns and best practices.

## Requirements
- Generate detailed, actionable plans from issue analysis
- Incorporate codebase conventions and patterns
- Break down complex tasks appropriately
- Include relevant context and files
- Produce plans that work with existing rmplan infrastructure

## Implementation Steps

### Step 1: Define Plan Generation Strategies
Create `src/rmapp/planning/strategy.ts` with all strategies:
```typescript
interface PlanStrategy {
  name: string;
  canHandle(analysis: IssueAnalysis): boolean;
  generateSteps(analysis: IssueAnalysis): Promise<PlanStep[]>;
}

// Implement all strategies from the start:

class FeatureStrategy implements PlanStrategy {
  name = 'feature';
  
  canHandle(analysis: IssueAnalysis): boolean {
    return analysis.type === 'feature';
  }
  
  async generateSteps(analysis: IssueAnalysis): Promise<PlanStep[]> {
    // 1. Design phase (if complex)
    // 2. Implementation phase
    // 3. Testing phase
    // 4. Documentation phase
  }
}

class BugFixStrategy implements PlanStrategy {
  name = 'bug';
  
  async generateSteps(analysis: IssueAnalysis): Promise<PlanStep[]> {
    // 1. Reproduce/understand bug
    // 2. Implement fix
    // 3. Add regression tests
    // 4. Verify fix
  }
}

class RefactorStrategy implements PlanStrategy {
  name = 'refactor';
  
  async generateSteps(analysis: IssueAnalysis): Promise<PlanStep[]> {
    // 1. Analyze current implementation
    // 2. Plan refactoring approach
    // 3. Implement changes incrementally
    // 4. Ensure tests still pass
  }
}

class DocumentationStrategy implements PlanStrategy {
  name = 'documentation';
  
  async generateSteps(analysis: IssueAnalysis): Promise<PlanStep[]> {
    // 1. Analyze documentation needs
    // 2. Write/update documentation
    // 3. Add examples if needed
    // 4. Update related docs
  }
}

class TestStrategy implements PlanStrategy {
  name = 'test';
  
  async generateSteps(analysis: IssueAnalysis): Promise<PlanStep[]> {
    // 1. Identify test gaps
    // 2. Write unit tests
    // 3. Add integration tests if needed
    // 4. Verify coverage improvement
  }
}
```

### Step 2: Create Step Generator
Implement `src/rmapp/planning/step_generator.ts`:
```typescript
class StepGenerator {
  generateImplementationSteps(
    requirements: Requirement[],
    scope: TechnicalScope
  ): PlanStep[] {
    // Group related requirements
    // Order by dependencies
    // Create atomic steps
    // Add verification criteria
  }
  
  generateTestingSteps(
    implementation: PlanStep[],
    testingScope: TestingRequirements
  ): PlanStep[] {
    // Unit test steps
    // Integration test steps
    // E2E test steps (if needed)
  }
  
  private createStep(config: StepConfig): PlanStep {
    return {
      title: config.title,
      description: config.description,
      acceptance_criteria: config.criteria,
      technical_notes: config.notes,
      estimated_complexity: config.complexity
    };
  }
}
```

### Step 3: Build Context Gatherer
Create `src/rmapp/planning/context.ts`:
```typescript
class PlanContextGatherer {
  async gatherContext(
    analysis: IssueAnalysis
  ): Promise<PlanContext> {
    // Find relevant files
    const files = await this.findRelevantFiles(analysis);
    
    // Gather examples
    const examples = await this.findExamples(analysis);
    
    // Get documentation
    const docs = await this.findDocumentation(analysis);
    
    // Find tests
    const tests = await this.findRelatedTests(files);
    
    return { files, examples, docs, tests };
  }
  
  private async findRelevantFiles(
    analysis: IssueAnalysis
  ): Promise<string[]> {
    // Use rmfind with smart queries
    // Include definitely needed files
    // Add commonly changed together files
    // Include configuration files
  }
}
```

### Step 4: Implement Plan Optimizer
Create `src/rmapp/planning/optimizer.ts`:
```typescript
class PlanOptimizer {
  optimize(steps: PlanStep[], context: PlanContext): PlanStep[] {
    // Merge related steps
    // Order by dependencies
    // Balance step complexity
    // Add parallel markers
    // Inject context at right points
  }
  
  private detectDependencies(steps: PlanStep[]): DependencyGraph {
    // Analyze step descriptions
    // Find explicit dependencies
    // Detect implicit dependencies
    // Create DAG
  }
  
  private balanceComplexity(steps: PlanStep[]): PlanStep[] {
    // Split complex steps
    // Merge simple steps
    // Aim for consistent size
  }
}
```

### Step 5: Create Instruction Generator
Build `src/rmapp/planning/instructions.ts`:
```typescript
class InstructionGenerator {
  generateStepInstructions(
    step: PlanStep,
    context: PlanContext,
    patterns: Pattern[]
  ): string {
    // Core instruction
    let instruction = this.generateCore(step);
    
    // Add patterns
    instruction += this.addPatterns(patterns);
    
    // Add constraints
    instruction += this.addConstraints(step);
    
    // Add examples
    instruction += this.addExamples(context.examples);
    
    return instruction;
  }
  
  generateGlobalInstructions(
    analysis: IssueAnalysis,
    patterns: Pattern[]
  ): string {
    // Project conventions
    // Architecture guidelines
    // Quality requirements
    // Security considerations
  }
}
```

### Step 6: Build Plan Formatter
Create `src/rmapp/planning/formatter.ts`:
```typescript
class PlanFormatter {
  format(
    plan: GeneratedPlan,
    metadata: PlanMetadata
  ): RmplanFile {
    return {
      title: metadata.title,
      description: this.formatDescription(metadata),
      steps: this.formatSteps(plan.steps),
      config: this.generateConfig(plan),
      metadata: {
        generated_from: `issue#${metadata.issueNumber}`,
        generated_at: new Date().toISOString(),
        generator_version: "1.0.0"
      }
    };
  }
  
  private formatSteps(steps: PlanStep[]): FormattedStep[] {
    return steps.map((step, index) => ({
      ...step,
      status: 'pending',
      order: index + 1,
      rmfilter_args: this.generateRmfilterArgs(step)
    }));
  }
}
```

### Step 7: Create Plan Validator
Implement `src/rmapp/planning/validator.ts`:
```typescript
class PlanValidator {
  validate(plan: RmplanFile): ValidationResult {
    // Check step completeness
    // Verify file references
    // Validate instructions
    // Check complexity balance
    // Ensure executability
  }
  
  async testExecutability(
    plan: RmplanFile,
    dryRun: boolean = true
  ): Promise<ExecutabilityResult> {
    // Test rmfilter commands
    // Verify file access
    // Check instruction clarity
    // Estimate execution time
  }
}
```

### Step 8: Build Generation Pipeline
Combine in `src/rmapp/planning/pipeline.ts`:
```typescript
class PlanGenerationPipeline {
  async generate(
    analysis: IssueAnalysis
  ): Promise<RmplanFile> {
    // Select strategy
    const strategy = this.selectStrategy(analysis);
    
    // Generate raw steps
    const steps = await strategy.generateSteps(analysis);
    
    // Gather context
    const context = await this.contextGatherer.gather(analysis);
    
    // Optimize steps
    const optimized = this.optimizer.optimize(steps, context);
    
    // Generate instructions
    const withInstructions = this.addInstructions(optimized, context);
    
    // Format plan
    const formatted = this.formatter.format(withInstructions, analysis);
    
    // Validate
    const validation = await this.validator.validate(formatted);
    if (!validation.valid) {
      throw new PlanGenerationError(validation.errors);
    }
    
    return formatted;
  }
}
```

## Testing Strategy
1. Test strategy selection
2. Test step generation quality
3. Test context gathering
4. Test plan optimization
5. Test full generation pipeline
6. Compare generated plans with hand-written ones

## Success Criteria
- [ ] Generates executable plans from issues
- [ ] Plans follow codebase conventions
- [ ] Steps are appropriately sized
- [ ] Context is comprehensive
- [ ] Plans succeed when executed