import type { EnrichedAnalysis } from '../analysis/types.js';
import type { 
  RmplanFile, 
  GeneratedPlan, 
  PlanMetadata,
  PlanContext 
} from './types.js';
import { StrategyFactory } from './strategies.js';
import { StepGenerator } from './step_generator.js';
import { PlanContextGatherer } from './context.js';
import { PlanOptimizer } from './optimizer.js';
import { InstructionGenerator } from './instructions.js';
import { PlanFormatter } from './formatter.js';
import { PlanValidator } from './validator.js';
import { ClaudeCodeExecutor } from '../../rmplan/executors/claude_code.js';
import type { ClaudeCodeExecutorOptions } from '../../rmplan/executors/claude_code.js';
import { log } from '../../logging.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'yaml';

export class PlanGenerationPipeline {
  private strategyFactory = new StrategyFactory();
  private stepGenerator = new StepGenerator();
  private contextGatherer = new PlanContextGatherer();
  private optimizer = new PlanOptimizer();
  private instructionGenerator = new InstructionGenerator();
  private formatter = new PlanFormatter();
  private validator = new PlanValidator();

  async generate(
    analysis: EnrichedAnalysis,
    workDir: string,
    outputPath?: string
  ): Promise<RmplanFile> {
    log(`Generating plan for ${analysis.type} issue`);
    
    // Determine output path
    const planPath = outputPath || this.generatePlanPath(analysis, workDir);
    
    try {
      // Use Claude Code to generate the complete plan
      const plan = await this.generateWithClaude(analysis, workDir, planPath);
      
      // Validate the generated plan
      const validation = this.validator.validate(plan);
      if (!validation.valid) {
        log('Plan validation failed:', validation.errors);
        // Fall back to programmatic generation
        return this.generateProgrammatically(analysis, workDir, planPath);
      }
      
      return plan;
    } catch (error) {
      log('Claude generation failed, using programmatic approach:', error);
      return this.generateProgrammatically(analysis, workDir, planPath);
    }
  }

  private async generateWithClaude(
    analysis: EnrichedAnalysis,
    workDir: string,
    planPath: string
  ): Promise<RmplanFile> {
    const config: ClaudeCodeExecutorOptions = {
      allowedTools: ['Write', 'Read', 'Glob', 'TodoWrite'],
      includeDefaultTools: false,
    };

    const executor = new ClaudeCodeExecutor(
      config,
      { 
        model: 'claude-3-5-sonnet-20241022',
        baseDir: workDir 
      },
      { defaultExecutor: 'claude-code' }
    );

    const strategyGuide = this.getStrategyGuide(analysis.type);
    const prompt = `Generate a complete rmplan YAML file for implementing this issue.

Issue Analysis:
${JSON.stringify(analysis, null, 2)}

Requirements:
1. Create a step-by-step plan using the ${analysis.type} strategy
2. Each step should be atomic and testable
3. Include all necessary context files for each step
4. Add clear instructions for Claude Code to execute
5. Follow the project's conventions and patterns

${strategyGuide}

The plan should have this structure:
\`\`\`yaml
title: "Clear, descriptive title"
description: |
  Detailed description of what this plan accomplishes
instructions: |
  Global instructions that apply to all steps
steps:
  - title: "Step title"
    description: "What this step does"
    instructions: |
      Detailed instructions for Claude Code
      Include acceptance criteria as checkboxes
    rmfilter_args: ["--with-imports", "file1.ts", "file2.ts"]
    status: pending
config:
  model: claude-3-5-sonnet-20241022
  defaultExecutor: claude-code
metadata:
  generated_from: "issue#${analysis.issueNumber || 'unknown'}"
  strategy: "${analysis.type}"
\`\`\`

Write the complete plan to: ${planPath}

Important:
- Make steps specific and actionable
- Include all files that need to be modified in rmfilter_args
- Add acceptance criteria as checkboxes in instructions
- Keep each step focused on a single goal`;

    await executor.execute(prompt);
    
    // Load and validate the generated plan
    const planContent = await fs.readFile(planPath, 'utf-8');
    const plan = parse(planContent) as RmplanFile;
    
    return plan;
  }

  private async generateProgrammatically(
    analysis: EnrichedAnalysis,
    workDir: string,
    planPath: string
  ): Promise<RmplanFile> {
    // Get the appropriate strategy
    const strategy = this.strategyFactory.getStrategy(analysis);
    
    // Gather context
    const context = await this.contextGatherer.gatherContext(analysis, workDir);
    
    // Generate steps using the strategy
    const steps = await strategy.generateSteps(analysis, context);
    
    // Optimize the steps
    const optimizedSteps = this.optimizer.optimize(steps, context);
    
    // Generate global instructions
    const globalInstructions = this.instructionGenerator.generateGlobalInstructions(analysis);
    
    // Create the plan
    const plan: GeneratedPlan = {
      steps: optimizedSteps,
      context,
      strategy: strategy.name,
      globalInstructions,
    };
    
    // Create metadata
    const metadata: PlanMetadata = {
      title: this.generateTitle(analysis),
      description: this.generateDescription(analysis),
      issueNumber: this.extractIssueNumber(analysis),
      issueUrl: this.generateIssueUrl(analysis),
      generatedAt: new Date(),
      strategy: strategy.name,
    };
    
    // Format the plan
    const formattedPlan = this.formatter.format(plan, metadata, analysis);
    
    // Save the plan
    await this.savePlan(formattedPlan, planPath, plan, metadata, analysis);
    
    return formattedPlan;
  }

  private getStrategyGuide(type: string): string {
    const strategies: Record<string, string> = {
      feature: `Feature Strategy:
1. Design phase (if complex) - Plan architecture and API
2. Implementation phase - Build the feature incrementally
3. Testing phase - Add comprehensive tests
4. Documentation phase - Update docs and examples`,
      
      bug: `Bug Fix Strategy:
1. Reproduce/understand - Create minimal reproduction
2. Implement fix - Fix root cause with minimal changes
3. Add regression tests - Prevent reoccurrence
4. Verify fix - Ensure no side effects`,
      
      refactor: `Refactor Strategy:
1. Analyze current implementation - Document existing behavior
2. Ensure test coverage - Add tests if needed
3. Refactor incrementally - Make changes step by step
4. Clean up - Remove dead code, optimize`,
      
      documentation: `Documentation Strategy:
1. Analyze needs - Identify gaps and audience
2. Write/update docs - Create clear content
3. Add examples - Provide working examples
4. Update related - Ensure consistency`,
      
      test: `Test Strategy:
1. Identify gaps - Find untested code
2. Write unit tests - Test individual functions
3. Add integration tests - Test workflows
4. Verify coverage - Ensure targets are met`,
    };
    
    return strategies[type] || strategies.feature;
  }

  private generatePlanPath(analysis: EnrichedAnalysis, workDir: string): string {
    const timestamp = new Date().toISOString().split('T')[0];
    const issueNum = this.extractIssueNumber(analysis);
    const type = analysis.type;
    
    const filename = `${timestamp}-issue-${issueNum}-${type}.yml`;
    return path.join(workDir, 'tasks', filename);
  }

  private extractIssueNumber(analysis: EnrichedAnalysis): number {
    // Try to extract from references
    if (analysis.references.issues.length > 0) {
      return analysis.references.issues[0].number;
    }
    
    // Try to extract from any field that might contain it
    const numberMatch = JSON.stringify(analysis).match(/#(\d+)/);
    if (numberMatch) {
      return parseInt(numberMatch[1], 10);
    }
    
    return 0;
  }

  private generateTitle(analysis: EnrichedAnalysis): string {
    const prefix = {
      feature: 'Implement',
      bug: 'Fix',
      refactor: 'Refactor',
      documentation: 'Document',
      test: 'Test',
      other: 'Handle',
    }[analysis.type];
    
    const mainReq = analysis.requirements[0]?.description || 'issue';
    const truncated = mainReq.length > 50 ? mainReq.substring(0, 47) + '...' : mainReq;
    
    return `${prefix} ${truncated}`;
  }

  private generateDescription(analysis: EnrichedAnalysis): string {
    const parts: string[] = [];
    
    parts.push(`This plan implements a ${analysis.type} to address the following requirements:`);
    
    analysis.requirements.slice(0, 3).forEach(req => {
      parts.push(`- ${req.description}`);
    });
    
    if (analysis.requirements.length > 3) {
      parts.push(`- ... and ${analysis.requirements.length - 3} more`);
    }
    
    return parts.join('\n');
  }

  private generateIssueUrl(analysis: EnrichedAnalysis): string {
    // Try to find from references
    const issueRef = analysis.references.issues[0];
    if (issueRef?.url) {
      return issueRef.url;
    }
    
    // Generate a placeholder
    return 'https://github.com/owner/repo/issues/XXX';
  }

  private async savePlan(
    plan: RmplanFile,
    planPath: string,
    generatedPlan: GeneratedPlan,
    metadata: PlanMetadata,
    analysis: EnrichedAnalysis
  ): Promise<void> {
    // Ensure directory exists
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    
    // Save as YAML
    const yamlContent = this.formatter.formatAsYaml(generatedPlan, metadata, analysis);
    await fs.writeFile(planPath, yamlContent);
    
    // Also save as Markdown for reference
    const mdPath = planPath.replace('.yml', '.md');
    const mdContent = this.formatter.formatAsMarkdown(generatedPlan, metadata, analysis);
    await fs.writeFile(mdPath, mdContent);
    
    log(`Plan saved to: ${planPath}`);
  }

  async loadAndValidate(planPath: string): Promise<RmplanFile> {
    const content = await fs.readFile(planPath, 'utf-8');
    const plan = parse(content) as RmplanFile;
    
    const validation = this.validator.validate(plan);
    if (!validation.valid) {
      throw new Error(`Invalid plan: ${validation.errors.join(', ')}`);
    }
    
    return plan;
  }
}