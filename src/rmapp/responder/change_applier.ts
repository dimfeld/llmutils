import { execSync } from 'child_process';
import type { AnalyzedChange, AppliedChange, ChangeResult } from './types.js';
import type { ChangeType } from '../reviews/types.js';
import { ClaudeCodeExecutor } from '../../rmplan/executors/claude_code.js';
import type { RmplanConfig } from '../../rmplan/configSchema.js';

export class ChangeApplier {
  constructor(
    private rmplanConfig: RmplanConfig = { defaultExecutor: 'claude-code' }
  ) {}

  async applyChange(
    request: AnalyzedChange,
    workspace: string
  ): Promise<AppliedChange> {
    // Use Claude Code to apply the requested change
    const executor = new ClaudeCodeExecutor(
      {
        allowedTools: ['Read', 'Edit', 'MultiEdit', 'Bash(git diff:*)'],
        includeDefaultTools: false
      },
      { model: 'sonnet', baseDir: workspace },
      this.rmplanConfig
    );
    
    const prompt = this.buildChangePrompt(request);
    
    // Execute the change
    const result = await executor.execute(prompt);
    
    // Get the diff
    const diff = await this.getDiff(request.location?.file || '', workspace);
    
    return {
      file: request.location?.file || '',
      diff,
      description: request.description,
      type: request.type as ChangeType,
      location: request.location!
    };
  }

  async applyMultipleChanges(
    requests: AnalyzedChange[],
    workspace: string
  ): Promise<ChangeResult> {
    const changes: AppliedChange[] = [];
    const details: any = {};
    
    try {
      // Sort by location to apply from bottom to top
      const sorted = this.sortByLocation(requests);
      
      for (const request of sorted) {
        try {
          const change = await this.applyChange(request, workspace);
          changes.push(change);
        } catch (error) {
          console.error(`Failed to apply change: ${error instanceof Error ? error.message : String(error)}`);
          // Continue with other changes
        }
      }
      
      // Extract details from changes
      const changeType = requests[0]?.type as ChangeType || 'other';
      
      return {
        status: changes.length === requests.length ? 'success' : 
                changes.length > 0 ? 'partial' : 'failed',
        changes,
        details: this.extractDetails(changes, changeType),
        changeType,
        language: this.detectLanguage(changes[0]?.file)
      };
    } catch (error) {
      return {
        status: 'failed',
        changes: [],
        details: { errors: [error instanceof Error ? error.message : String(error)] },
        changeType: 'other'
      };
    }
  }

  private buildChangePrompt(request: AnalyzedChange): string {
    const typeSpecificInstructions = this.getTypeSpecificInstructions(request.type as ChangeType);
    
    return `Apply the following review feedback:

File: ${request.location?.file || 'unknown'}
Location: Lines ${request.location?.startLine}-${request.location?.endLine || request.location?.startLine}
Change Type: ${request.type}
Request: ${request.description}

Original Review Comment:
${request.originalComment}

Instructions:
1. Read the file and understand the context
2. Apply the requested change:
${typeSpecificInstructions}
3. Ensure the change follows project conventions
4. Make only the requested change, nothing more

Be precise and focused on the specific request.`;
  }

  private getTypeSpecificInstructions(type: ChangeType): string {
    const instructions: Record<ChangeType, string> = {
      errorHandling: `   - Add appropriate try-catch blocks or error checks
   - Include meaningful error messages
   - Handle errors gracefully without crashing
   - Log errors appropriately`,
      
      validation: `   - Add input validation with clear error messages
   - Check for null/undefined values
   - Validate data types and ranges
   - Return early on invalid input`,
      
      logging: `   - Add meaningful log statements for debugging
   - Include relevant context in logs
   - Use appropriate log levels (debug, info, warn, error)
   - Avoid logging sensitive information`,
      
      documentation: `   - Add JSDoc/docstrings as appropriate
   - Include parameter descriptions
   - Document return values
   - Add usage examples if helpful`,
      
      test: `   - Add comprehensive test cases
   - Cover edge cases and error conditions
   - Use descriptive test names
   - Follow existing test patterns`,
      
      refactoring: `   - Improve code structure while maintaining functionality
   - Extract reusable functions/methods
   - Improve naming for clarity
   - Reduce complexity where possible`,
      
      typefix: `   - Fix type errors or add type annotations
   - Ensure type safety
   - Use proper TypeScript types
   - Avoid using 'any' type`,
      
      performance: `   - Optimize for better performance
   - Reduce unnecessary operations
   - Use efficient algorithms
   - Consider memory usage`,
      
      security: `   - Address security vulnerabilities
   - Validate and sanitize inputs
   - Use secure coding practices
   - Avoid exposing sensitive data`,
      
      other: `   - Follow the specific instructions in the request
   - Make changes that address the reviewer's concern
   - Maintain code quality and consistency`
    };
    
    return instructions[type] || instructions.other;
  }

  private async getDiff(file: string, workspace: string): Promise<string> {
    try {
      const diff = execSync(`git diff --no-index /dev/null ${file} || git diff ${file}`, {
        cwd: workspace,
        encoding: 'utf-8'
      });
      return diff.trim();
    } catch (error: any) {
      // Git diff returns non-zero exit code when there are differences
      return error.stdout || '';
    }
  }

  private sortByLocation(requests: AnalyzedChange[]): AnalyzedChange[] {
    return [...requests].sort((a, b) => {
      if (!a.location || !b.location) return 0;
      if (a.location.file !== b.location.file) {
        return a.location.file.localeCompare(b.location.file);
      }
      // Sort by line number in reverse order (bottom to top)
      return (b.location.startLine || 0) - (a.location.startLine || 0);
    });
  }

  private extractDetails(changes: AppliedChange[], changeType: ChangeType): any {
    const details: any = {};
    
    switch (changeType) {
      case 'validation':
        details.validatedFields = this.extractValidatedFields(changes);
        break;
      case 'logging':
        details.loggedEvents = this.extractLoggedEvents(changes);
        break;
      case 'test':
        details.testedFunctions = this.extractTestedFunctions(changes);
        break;
      case 'refactoring':
        details.refactoringDescription = this.summarizeRefactoring(changes);
        break;
    }
    
    // Add code snippet from first change
    if (changes.length > 0) {
      details.codeSnippet = this.extractCodeSnippet(changes[0].diff);
    }
    
    return details;
  }

  private extractValidatedFields(changes: AppliedChange[]): string[] {
    // Parse diffs to find validation patterns
    const fields: string[] = [];
    
    for (const change of changes) {
      const matches = change.diff.match(/validate\w*|check\w*|verify\w*/gi);
      if (matches) {
        fields.push(...matches);
      }
    }
    
    return [...new Set(fields)];
  }

  private extractLoggedEvents(changes: AppliedChange[]): string[] {
    const events: string[] = [];
    
    for (const change of changes) {
      const matches = change.diff.match(/log\.(debug|info|warn|error)\(['"](.*?)['"]/g);
      if (matches) {
        events.push(...matches.map(m => m.replace(/log\.\w+\(['"]/, '').replace(/['"].*/, '')));
      }
    }
    
    return [...new Set(events)];
  }

  private extractTestedFunctions(changes: AppliedChange[]): string[] {
    const functions: string[] = [];
    
    for (const change of changes) {
      const matches = change.diff.match(/(?:test|it|describe)\(['"](.*?)['"]/g);
      if (matches) {
        functions.push(...matches.map(m => m.replace(/(?:test|it|describe)\(['"]/, '').replace(/['"].*/, '')));
      }
    }
    
    return [...new Set(functions)];
  }

  private summarizeRefactoring(changes: AppliedChange[]): string {
    const summaries = changes.map(c => c.description).filter(Boolean);
    
    if (summaries.length === 0) {
      return 'Code structure improved';
    } else if (summaries.length === 1) {
      return summaries[0];
    } else {
      return `${summaries.length} improvements made`;
    }
  }

  private extractCodeSnippet(diff: string): string {
    // Extract the most relevant added lines
    const addedLines = diff
      .split('\n')
      .filter(line => line.startsWith('+') && !line.startsWith('+++'))
      .map(line => line.substring(1))
      .slice(0, 10)
      .join('\n');
    
    return addedLines.trim();
  }

  private detectLanguage(file?: string): string {
    if (!file) return 'text';
    
    const ext = file.split('.').pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      py: 'python',
      java: 'java',
      go: 'go',
      rs: 'rust',
      cpp: 'cpp',
      c: 'c',
      cs: 'csharp',
      rb: 'ruby',
      php: 'php',
      swift: 'swift',
      kt: 'kotlin',
      scala: 'scala',
      r: 'r',
      m: 'objective-c',
      mm: 'objective-c++',
    };
    
    return langMap[ext || ''] || 'text';
  }
}