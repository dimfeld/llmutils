import type { 
  GitHubIssue, 
  IssueAnalysis, 
  RepoContext,
  Requirement,
  TechnicalScope,
  EnrichedAnalysis,
  ParsedIssue
} from './types.js';
import { IssueParser } from './parser.js';
import { ReferenceExtractor } from './references.js';
import { PatternMatcher } from './patterns.js';
import { ContextEnricher } from './context.js';
import { ClaudeCodeExecutor } from '../../rmplan/executors/claude_code.js';
import type { ClaudeCodeExecutorOptions } from '../../rmplan/executors/claude_code.js';
import { log } from '../../logging.js';

export class AnalysisPipeline {
  private parser = new IssueParser();
  private referenceExtractor = new ReferenceExtractor();
  private patternMatcher = new PatternMatcher();
  private contextEnricher = new ContextEnricher();

  async analyze(issue: GitHubIssue, context: RepoContext): Promise<EnrichedAnalysis> {
    log(`Starting analysis of issue #${issue.number}: ${issue.title}`);
    
    try {
      // Use Claude Code for comprehensive analysis
      const config: ClaudeCodeExecutorOptions = {
        allowedTools: ['Read', 'Glob', 'Grep', 'TodoWrite', 'TodoRead'],
        includeDefaultTools: false,
      };

      const executor = new ClaudeCodeExecutor(
        config,
        { 
          model: 'claude-3-5-sonnet-20241022',
          baseDir: context.workDir 
        },
        { defaultExecutor: 'claude-code' }
      );

      const prompt = this.buildAnalysisPrompt(issue);
      const result = await executor.execute(prompt);
      
      // Parse the analysis result
      const analysis = await this.parseAnalysisResult(result, issue, context);
      
      // Enrich with additional context
      const enrichedAnalysis = await this.contextEnricher.enrich(analysis, context);
      
      log(`Analysis complete for issue #${issue.number}`);
      return enrichedAnalysis;
    } catch (error) {
      log('Error in analysis pipeline:', error);
      
      // Fallback to basic analysis
      return this.basicAnalysis(issue, context);
    }
  }

  private buildAnalysisPrompt(issue: GitHubIssue): string {
    return `Analyze this GitHub issue comprehensively and provide a structured analysis:

Issue #${issue.number}: ${issue.title}
${issue.body || 'No description provided'}

Labels: ${issue.labels.map(l => l.name).join(', ')}

Please analyze and provide a JSON response with the following structure:

{
  "type": "feature|bug|refactor|documentation|test|other",
  "requirements": [
    {
      "id": "req-1",
      "description": "Clear requirement description",
      "priority": "must|should|could",
      "acceptanceCriteria": ["Specific criteria"]
    }
  ],
  "technicalScope": {
    "affectedFiles": ["List of files that need to be modified"],
    "suggestedFiles": ["Additional files that might need changes"],
    "relatedPatterns": ["Patterns or conventions to follow"],
    "dependencies": ["External libraries or modules involved"]
  },
  "references": {
    "files": [{"path": "file.ts", "reason": "why referenced"}],
    "issues": [{"number": 123, "url": "github.com/..."}],
    "prs": [{"number": 456, "url": "github.com/..."}],
    "documentation": [{"url": "...", "title": "...", "type": "internal|external"}],
    "codeSnippets": [{"language": "typescript", "code": "...", "description": "..."}]
  },
  "suggestedApproach": "High-level approach to implement this",
  "confidence": 0.85
}

Instructions:
1. Extract all requirements from the issue, including implicit ones
2. Identify all files that would need to be modified
3. Find any referenced issues, PRs, or documentation
4. Suggest implementation approach based on codebase patterns
5. Use grep and glob to verify file paths exist
6. Set confidence based on clarity of requirements (0-1)

Return only the JSON object, no additional text.`;
  }

  private async parseAnalysisResult(
    result: any, 
    issue: GitHubIssue,
    context: RepoContext
  ): Promise<IssueAnalysis> {
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
        
        // Parse the JSON
        const parsed = JSON.parse(jsonStr);
        
        // Validate and return
        return this.validateAnalysis(parsed);
      }
    } catch (error) {
      log('Failed to parse Claude Code analysis result:', error);
    }
    
    // Fallback to basic analysis
    return this.basicAnalysis(issue, context);
  }

  private validateAnalysis(analysis: any): IssueAnalysis {
    // Ensure all required fields exist with proper types
    return {
      type: analysis.type || 'other',
      requirements: Array.isArray(analysis.requirements) ? analysis.requirements : [],
      technicalScope: {
        affectedFiles: Array.isArray(analysis.technicalScope?.affectedFiles) 
          ? analysis.technicalScope.affectedFiles 
          : [],
        suggestedFiles: Array.isArray(analysis.technicalScope?.suggestedFiles)
          ? analysis.technicalScope.suggestedFiles
          : [],
        relatedPatterns: Array.isArray(analysis.technicalScope?.relatedPatterns)
          ? analysis.technicalScope.relatedPatterns
          : [],
        dependencies: Array.isArray(analysis.technicalScope?.dependencies)
          ? analysis.technicalScope.dependencies
          : [],
      },
      references: {
        files: Array.isArray(analysis.references?.files) ? analysis.references.files : [],
        issues: Array.isArray(analysis.references?.issues) ? analysis.references.issues : [],
        prs: Array.isArray(analysis.references?.prs) ? analysis.references.prs : [],
        documentation: Array.isArray(analysis.references?.documentation) 
          ? analysis.references.documentation 
          : [],
        codeSnippets: Array.isArray(analysis.references?.codeSnippets)
          ? analysis.references.codeSnippets
          : [],
      },
      suggestedApproach: analysis.suggestedApproach || '',
      confidence: typeof analysis.confidence === 'number' 
        ? Math.max(0, Math.min(1, analysis.confidence))
        : 0.5,
    };
  }

  private async basicAnalysis(
    issue: GitHubIssue, 
    context: RepoContext
  ): Promise<EnrichedAnalysis> {
    // Parse the issue
    const parsedIssue = this.parser.parse(issue);
    const issueType = this.parser.analyzeType(parsedIssue, issue.labels.map(l => l.name));
    
    // Extract references
    const references = await this.referenceExtractor.extract(issue, context);
    
    // Extract requirements from sections
    const requirements = this.extractRequirements(parsedIssue);
    
    // Build technical scope from references
    const technicalScope: TechnicalScope = {
      affectedFiles: references.files.map(f => f.path),
      suggestedFiles: [],
      relatedPatterns: [],
      dependencies: [],
    };
    
    // Get implementation suggestion
    const implementationSuggestion = await this.patternMatcher.suggestImplementationApproach({
      type: issueType,
      requirements,
      technicalScope,
      references,
      confidence: 0.6,
    });
    
    const analysis: IssueAnalysis = {
      type: issueType,
      requirements,
      technicalScope,
      references,
      suggestedApproach: implementationSuggestion.approach,
      confidence: 0.6,
    };
    
    // Enrich with context
    return this.contextEnricher.enrich(analysis, context);
  }

  private extractRequirements(parsedIssue: ParsedIssue): Requirement[] {
    const requirements: Requirement[] = [];
    let reqId = 1;
    
    // Extract from requirements section
    const reqSection = parsedIssue.sections.get('requirements');
    if (reqSection) {
      const lines = reqSection.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          requirements.push({
            id: `req-${reqId++}`,
            description: trimmed.replace(/^[-*]\s*/, ''),
            priority: 'should',
          });
        }
      }
    }
    
    // Extract from acceptance criteria
    const acSection = parsedIssue.sections.get('acceptance criteria');
    if (acSection) {
      const lines = acSection.split('\n');
      const acceptanceCriteria: string[] = [];
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          acceptanceCriteria.push(trimmed.replace(/^[-*]\s*/, ''));
        }
      }
      
      if (acceptanceCriteria.length > 0 && requirements.length > 0) {
        requirements[0].acceptanceCriteria = acceptanceCriteria;
      }
    }
    
    // If no explicit requirements, extract from description
    if (requirements.length === 0) {
      const description = parsedIssue.sections.get('description') || parsedIssue.body;
      const sentences = description.split(/[.!?]+/);
      
      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (trimmed && (
          trimmed.includes('should') || 
          trimmed.includes('must') || 
          trimmed.includes('need') ||
          trimmed.includes('want')
        )) {
          requirements.push({
            id: `req-${reqId++}`,
            description: trimmed,
            priority: trimmed.includes('must') ? 'must' : 'should',
          });
        }
      }
    }
    
    return requirements;
  }
}