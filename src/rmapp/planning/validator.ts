import type { RmplanFile, ValidationResult, ExecutabilityResult } from './types.js';
import { spawnAndLogOutput } from '../../rmfilter/utils.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { log } from '../../logging.js';

export class PlanValidator {
  validate(plan: RmplanFile): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];
    
    // Check required fields
    if (!plan.goal) {
      errors.push('Plan must have a goal');
    }
    
    if (!plan.tasks || plan.tasks.length === 0) {
      errors.push('Plan must have at least one task');
    }
    
    // Check task completeness
    plan.tasks.forEach((task, index) => {
      const taskNum = index + 1;
      
      if (!task.title) {
        errors.push(`Task ${taskNum} must have a title`);
      }
      
      if (!task.description) {
        errors.push(`Task ${taskNum} must have a description`);
      }
      
      if (!task.steps || task.steps.length === 0) {
        errors.push(`Task ${taskNum} must have at least one step`);
      }
      
      // Check file references
      if (task.files) {
        task.files.forEach((file: string) => {
          if (!file || file.trim() === '') {
            warnings.push(`Task ${taskNum} has empty file reference`);
          }
        });
      }
      
      // Check steps
      task.steps.forEach((step, stepIndex) => {
        if (!step.prompt) {
          errors.push(`Task ${taskNum}, Step ${stepIndex + 1} must have a prompt`);
        }
      });
    });
    
    // Check complexity balance
    const complexityBalance = this.checkComplexityBalance(plan);
    if (complexityBalance.unbalanced) {
      suggestions.push(complexityBalance.message);
    }
    
    // Check for very long prompts
    plan.tasks.forEach((task, index) => {
      task.steps.forEach((step, stepIndex) => {
        if (step.prompt && step.prompt.length > 2000) {
          suggestions.push(`Task ${index + 1}, Step ${stepIndex + 1} has very long prompt. Consider breaking it down.`);
        }
      });
    });
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      suggestions,
    };
  }

  async testExecutability(
    plan: RmplanFile,
    workDir: string,
    dryRun: boolean = true
  ): Promise<ExecutabilityResult> {
    const issues: string[] = [];
    const fileAccessChecks: ExecutabilityResult['fileAccessChecks'] = [];
    let estimatedDuration = 0;
    
    // Test each task
    for (let i = 0; i < plan.tasks.length; i++) {
      const task = plan.tasks[i];
      const taskNum = i + 1;
      
      // Estimate duration based on complexity
      estimatedDuration += this.estimateTaskDuration(task);
      
      // Check file access
      if (task.files) {
        for (const file of task.files) {
          const filePath = path.join(workDir, file);
          const check = await this.checkFileAccess(filePath);
          fileAccessChecks.push({
            file,
            ...check,
          });
          
          if (!check.exists) {
            issues.push(`Task ${taskNum}: File not found: ${file}`);
          } else if (!check.readable) {
            issues.push(`Task ${taskNum}: File not readable: ${file}`);
          }
        }
      }
      
      // Check step clarity
      task.steps.forEach((step, stepIndex) => {
        const clarityIssues = this.checkPromptClarity(step.prompt);
        if (clarityIssues.length > 0) {
          issues.push(`Task ${taskNum}, Step ${stepIndex + 1}: ${clarityIssues.join(', ')}`);
        }
      });
    }
    
    return {
      executable: issues.length === 0,
      issues,
      estimatedDuration,
      fileAccessChecks,
    };
  }

  private checkComplexityBalance(plan: RmplanFile): { unbalanced: boolean; message: string } {
    if (plan.tasks.length < 3) {
      return { unbalanced: false, message: '' };
    }
    
    // Count consecutive steps with same complexity
    let maxConsecutive = 0;
    let currentCount = 1;
    let currentComplexity = '';
    
    plan.tasks.forEach((task, i) => {
      const complexity = this.inferTaskComplexity(task);
      if (i === 0) {
        currentComplexity = complexity;
      } else if (complexity === currentComplexity) {
        currentCount++;
        maxConsecutive = Math.max(maxConsecutive, currentCount);
      } else {
        currentComplexity = complexity;
        currentCount = 1;
      }
    });
    
    if (maxConsecutive > 3) {
      return {
        unbalanced: true,
        message: `Consider varying step complexity - found ${maxConsecutive} consecutive steps with similar complexity`,
      };
    }
    
    return { unbalanced: false, message: '' };
  }

  private inferTaskComplexity(task: any): string {
    // Infer complexity from various indicators
    const totalPromptLength = task.steps?.reduce((sum: number, step: any) => 
      sum + (step.prompt || '').length, 0) || 0;
    const hasMultipleFiles = task.files && task.files.length > 3;
    const hasMultipleSteps = task.steps && task.steps.length > 2;
    
    if (totalPromptLength > 1000 || hasMultipleFiles || hasMultipleSteps) {
      return 'high';
    } else if (totalPromptLength > 500) {
      return 'medium';
    }
    return 'low';
  }

  private estimateTaskDuration(task: any): number {
    const complexity = this.inferTaskComplexity(task);
    
    switch (complexity) {
      case 'high':
        return 30; // 30 minutes
      case 'medium':
        return 15; // 15 minutes
      case 'low':
      default:
        return 5; // 5 minutes
    }
  }

  private async checkFileAccess(filePath: string): Promise<{ exists: boolean; readable: boolean }> {
    try {
      await fs.access(filePath, fs.constants.F_OK);
      const exists = true;
      
      try {
        await fs.access(filePath, fs.constants.R_OK);
        return { exists, readable: true };
      } catch {
        return { exists, readable: false };
      }
    } catch {
      return { exists: false, readable: false };
    }
  }

  private async testRmfilterCommand(
    args: string[],
    workDir: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await spawnAndLogOutput(
        ['rmfilter', '--dry-run', ...args],
        { cwd: workDir }
      );
      
      return {
        success: result.exitCode === 0,
        error: result.exitCode !== 0 ? result.stderr : undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private checkPromptClarity(prompt: string): string[] {
    const issues: string[] = [];
    
    if (!prompt) {
      return issues;
    }
    
    // Check for vague instructions
    const vagueWords = ['somehow', 'maybe', 'possibly', 'might', 'could'];
    const foundVague = vagueWords.filter(word => 
      prompt.toLowerCase().includes(word)
    );
    
    if (foundVague.length > 0) {
      issues.push(`Prompt contains vague language: ${foundVague.join(', ')}`);
    }
    
    // Check for missing acceptance criteria in prompt
    if (!prompt.includes('Acceptance') && !prompt.includes('criteria')) {
      issues.push('Prompt should include clear acceptance criteria');
    }
    
    return issues;
  }
}