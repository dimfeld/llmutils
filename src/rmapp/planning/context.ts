import type { EnrichedAnalysis } from '../analysis/types.js';
import type { PlanContext, FileContext, CodeExample, TestContext } from './types.js';
import { ClaudeCodeExecutor } from '../../rmplan/executors/claude_code.js';
import type { ClaudeCodeExecutorOptions } from '../../rmplan/executors/claude_code.js';
import { log } from '../../logging.js';

export class PlanContextGatherer {
  async gatherContext(
    analysis: EnrichedAnalysis,
    workDir: string
  ): Promise<PlanContext> {
    // Use Claude Code to intelligently gather context
    const config: ClaudeCodeExecutorOptions = {
      allowedTools: ['Read', 'Glob', 'Grep'],
      includeDefaultTools: false,
    };

    const executor = new ClaudeCodeExecutor(
      config,
      { 
        model: 'claude-3-haiku-20240307', // Fast model for context gathering
        baseDir: workDir 
      },
      { defaultExecutor: 'claude-code' }
    );

    const prompt = `Based on this issue analysis, find all relevant context for implementation:

Issue Analysis:
${JSON.stringify(analysis, null, 2)}

Please find:
1. Files that need to be modified or referenced (from technicalScope.affectedFiles and suggestedFiles)
2. Similar implementations or patterns in the codebase
3. Relevant documentation files (README, docs/, etc.)
4. Existing tests that should be updated or used as examples

For each file found, determine its purpose and relevance:
- "core": Files that will be directly modified
- "reference": Files to look at for patterns/examples
- "example": Similar implementations to learn from

Return a JSON object with this structure:
{
  "relevantFiles": [
    { "path": "src/example.ts", "purpose": "Main implementation file", "relevance": "core" }
  ],
  "examples": [
    { "file": "src/similar.ts", "description": "Similar feature implementation" }
  ],
  "documentation": ["README.md", "docs/api.md"],
  "tests": [
    { "file": "tests/example.test.ts", "type": "unit", "description": "Related unit tests" }
  ]
}`;

    try {
      const result = await executor.execute(prompt);
      const context = this.parseContextResult(result);
      
      // Merge with analysis data
      return this.mergeWithAnalysis(context, analysis);
    } catch (error) {
      log('Failed to gather context with Claude Code:', error);
      
      // Fallback to basic context from analysis
      return this.createBasicContext(analysis);
    }
  }

  private parseContextResult(result: any): Partial<PlanContext> {
    try {
      // Extract JSON from the result
      let jsonStr = result;
      if (typeof result === 'object' && result.output) {
        jsonStr = result.output;
      }
      
      if (typeof jsonStr === 'string') {
        // Try to extract JSON from markdown code blocks
        const jsonMatch = jsonStr.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          jsonStr = jsonMatch[1];
        }
        
        const parsed = JSON.parse(jsonStr);
        return {
          relevantFiles: parsed.relevantFiles || [],
          examples: parsed.examples || [],
          documentation: parsed.documentation || [],
          tests: parsed.tests || [],
          patterns: [], // Will be filled from analysis
        };
      }
    } catch (error) {
      log('Failed to parse context result:', error);
    }
    
    return {
      relevantFiles: [],
      examples: [],
      documentation: [],
      tests: [],
      patterns: [],
    };
  }

  private mergeWithAnalysis(
    context: Partial<PlanContext>, 
    analysis: EnrichedAnalysis
  ): PlanContext {
    const merged: PlanContext = {
      relevantFiles: context.relevantFiles || [],
      examples: context.examples || [],
      documentation: context.documentation || [],
      tests: context.tests || [],
      patterns: analysis.patterns || [],
    };
    
    // Add files from analysis if not already present
    const existingPaths = new Set(merged.relevantFiles.map(f => f.path));
    
    for (const file of analysis.technicalScope.affectedFiles) {
      if (!existingPaths.has(file)) {
        merged.relevantFiles.push({
          path: file,
          purpose: 'Affected by changes',
          relevance: 'core',
        });
      }
    }
    
    for (const file of analysis.technicalScope.suggestedFiles) {
      if (!existingPaths.has(file)) {
        merged.relevantFiles.push({
          path: file,
          purpose: 'Suggested for changes',
          relevance: 'reference',
        });
      }
    }
    
    // Add documentation references
    for (const doc of analysis.references.documentation) {
      if (doc.type === 'internal' && !merged.documentation.includes(doc.url)) {
        merged.documentation.push(doc.url);
      }
    }
    
    return merged;
  }

  private createBasicContext(analysis: EnrichedAnalysis): PlanContext {
    const context: PlanContext = {
      relevantFiles: [],
      examples: [],
      documentation: [],
      tests: [],
      patterns: analysis.patterns || [],
    };
    
    // Convert affected files
    for (const file of analysis.technicalScope.affectedFiles) {
      context.relevantFiles.push({
        path: file,
        purpose: 'Needs modification',
        relevance: 'core',
      });
    }
    
    // Convert suggested files
    for (const file of analysis.technicalScope.suggestedFiles) {
      context.relevantFiles.push({
        path: file,
        purpose: 'May need changes',
        relevance: 'reference',
      });
    }
    
    // Extract documentation
    for (const doc of analysis.references.documentation) {
      if (doc.type === 'internal') {
        context.documentation.push(doc.url);
      }
    }
    
    // Extract code examples from references
    for (const snippet of analysis.references.codeSnippets) {
      if (snippet.description) {
        context.examples.push({
          file: 'inline',
          description: snippet.description,
          code: snippet.code,
        });
      }
    }
    
    return context;
  }

  async findSimilarPlans(
    analysis: EnrichedAnalysis,
    plansDir: string = 'tasks'
  ): Promise<string[]> {
    // This would search for similar plans in the tasks directory
    // For now, return empty array
    return [];
  }
}