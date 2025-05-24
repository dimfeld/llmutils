import type { 
  GeneratedPlan, 
  PlanMetadata, 
  RmplanFile, 
  PlanStep, 
  FormattedStep,
  RmplanStep,
  RmplanTask
} from './types.js';
import { InstructionGenerator } from './instructions.js';
import type { EnrichedAnalysis } from '../analysis/types.js';
import { dump } from 'js-yaml';

export class PlanFormatter {
  private instructionGenerator = new InstructionGenerator();

  format(
    plan: GeneratedPlan,
    metadata: PlanMetadata,
    analysis: EnrichedAnalysis
  ): RmplanFile {
    return {
      goal: metadata.title,
      details: this.formatDescription(metadata, analysis),
      tasks: this.formatTasks(plan.steps, plan, analysis),
      config: this.generateConfig(plan, analysis),
      metadata: {
        generated_from: `issue#${metadata.issueNumber}`,
        generated_at: metadata.generatedAt.toISOString(),
        generator_version: '1.0.0',
        strategy: metadata.strategy,
        issue_url: metadata.issueUrl,
      },
    };
  }

  formatAsYaml(
    plan: GeneratedPlan,
    metadata: PlanMetadata,
    analysis: EnrichedAnalysis
  ): string {
    const rmplanFile = this.format(plan, metadata, analysis);
    
    // Remove optional fields if not needed
    const yamlData = {
      goal: rmplanFile.goal,
      details: rmplanFile.details,
      tasks: rmplanFile.tasks,
      ...(rmplanFile.config && { config: rmplanFile.config }),
      ...(rmplanFile.metadata && { metadata: rmplanFile.metadata }),
    };
    
    return dump(yamlData, { 
      lineWidth: 120,
      noRefs: true,
    });
  }

  formatAsMarkdown(
    plan: GeneratedPlan,
    metadata: PlanMetadata,
    analysis: EnrichedAnalysis
  ): string {
    const lines: string[] = [];
    
    // Header
    lines.push(`# ${metadata.title}`);
    lines.push('');
    lines.push(this.formatDescription(metadata, analysis));
    lines.push('');
    
    // Global instructions
    if (plan.globalInstructions) {
      lines.push(plan.globalInstructions);
      lines.push('');
    }
    
    // Steps
    lines.push('## Steps');
    lines.push('');
    
    plan.steps.forEach((step, index) => {
      const instructions = this.instructionGenerator.generateStepInstructions(
        step, 
        plan.context, 
        analysis
      );
      
      lines.push(`### Step ${index + 1}: ${step.title}`);
      lines.push('');
      lines.push(instructions);
      lines.push('');
      
      if (step.rmfilter_args) {
        lines.push('**Files to include:**');
        lines.push(`\`\`\`bash`);
        lines.push(`rmfilter ${step.rmfilter_args.join(' ')}`);
        lines.push(`\`\`\``);
        lines.push('');
      }
    });
    
    // Metadata
    lines.push('## Metadata');
    lines.push('');
    lines.push(`- Generated from: [Issue #${metadata.issueNumber}](${metadata.issueUrl})`);
    lines.push(`- Strategy: ${metadata.strategy}`);
    lines.push(`- Generated at: ${metadata.generatedAt.toISOString()}`);
    
    return lines.join('\n');
  }

  private formatDescription(metadata: PlanMetadata, analysis: EnrichedAnalysis): string {
    const parts: string[] = [metadata.description];
    
    if (analysis.suggestedApproach) {
      parts.push(`\nApproach: ${analysis.suggestedApproach}`);
    }
    
    if (analysis.confidence < 0.7) {
      parts.push(`\nNote: Lower confidence analysis (${Math.round(analysis.confidence * 100)}%). Manual review recommended.`);
    }
    
    return parts.join('\n');
  }

  private formatTasks(
    steps: PlanStep[], 
    plan: GeneratedPlan,
    analysis: EnrichedAnalysis
  ): RmplanTask[] {
    // Group steps into tasks - for now, create one task per step
    // In a more sophisticated version, we'd group related steps
    return steps.map((step, index) => {
      const task: RmplanTask = {
        title: step.title,
        description: step.description,
        files: step.context_files || [],
        include_imports: step.rmfilter_args?.includes('--with-imports') || false,
        include_importers: step.rmfilter_args?.includes('--with-importers') || false,
        steps: [{
          prompt: this.instructionGenerator.generateStepInstructions(
            step, 
            plan.context, 
            analysis
          ),
          done: false,
        }],
      };
      
      return task;
    });
  }

  private generateConfig(plan: GeneratedPlan, analysis: EnrichedAnalysis): any {
    const config: any = {
      defaultExecutor: 'claude-code',
      model: 'claude-3-5-sonnet-20241022',
    };
    
    // Add specific config based on issue type
    switch (analysis.type) {
      case 'bug':
        config.allowedTools = ['Read', 'Write', 'Edit', 'MultiEdit', 'Grep', 'Glob', 'Bash'];
        config.cautious = true;
        break;
      case 'feature':
        config.allowedTools = ['Read', 'Write', 'Edit', 'MultiEdit', 'Grep', 'Glob', 'Bash', 'WebSearch'];
        break;
      case 'refactor':
        config.allowedTools = ['Read', 'Edit', 'MultiEdit', 'Grep', 'Glob'];
        config.cautious = true;
        break;
      case 'documentation':
        config.allowedTools = ['Read', 'Write', 'Edit'];
        break;
      case 'test':
        config.allowedTools = ['Read', 'Write', 'Edit', 'Bash'];
        break;
    }
    
    return config;
  }

  private generateRmfilterArgs(step: PlanStep): string[] {
    const args: string[] = [];
    
    if (!step.context_files || step.context_files.length === 0) {
      return args;
    }
    
    // Add import flags based on complexity
    if (step.estimated_complexity === 'high') {
      args.push('--with-all-imports');
    } else if (step.estimated_complexity === 'medium') {
      args.push('--with-imports');
    }
    
    // Add files
    args.push(...step.context_files);
    
    return args;
  }
}