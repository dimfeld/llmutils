# Issue Analyzer

## Overview
Build a system to analyze GitHub issues and extract structured requirements for implementation.

## Requirements
- Extract key requirements from issue descriptions
- Identify technical scope
- Detect referenced files, PRs, and documentation
- Classify issue type (feature, bug, refactor, etc.)
- Generate structured output for plan generation

## Implementation Steps

### Step 1: Create Issue Analysis Types
Define types in `src/rmapp/analysis/types.ts`:
```typescript
interface IssueAnalysis {
  type: 'feature' | 'bug' | 'refactor' | 'documentation' | 'test';
  requirements: Requirement[];
  technicalScope: TechnicalScope;
  references: References;
  suggestedApproach?: string;
}

interface Requirement {
  id: string;
  description: string;
  priority: 'must' | 'should' | 'could';
  acceptanceCriteria?: string[];
}

interface TechnicalScope {
  affectedFiles: string[];
  suggestedFiles: string[];
  relatedPatterns: string[];
  dependencies: string[];
}
```

### Step 2: Implement Issue Parser
Create `src/rmapp/analysis/parser.ts`:
```typescript
class IssueParser {
  parse(issue: GitHubIssue): ParsedIssue {
    // Extract structured sections
    // Parse markdown formatting
    // Identify code blocks
    // Extract links and references
  }
  
  private extractSections(body: string): Map<string, string> {
    // Look for common sections:
    // - Description
    // - Requirements
    // - Acceptance Criteria
    // - Technical Details
  }
}
```

### Step 3: Build Reference Extractor
Create `src/rmapp/analysis/references.ts`:
```typescript
class ReferenceExtractor {
  async extract(issue: GitHubIssue, context: RepoContext): Promise<References> {
    // Use Claude Code to intelligently extract references
    const executor = new ClaudeCodeExecutor(
      {
        allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch'],
        includeDefaultTools: false
      },
      { model: 'haiku' }, // Fast model for reference extraction
      context.rmplanConfig
    );
    
    const prompt = `Extract all relevant references from this issue:
- File paths mentioned
- Referenced issues/PRs (look for #123 format)
- Documentation links
- Code snippets
- Similar functionality in the codebase

Issue: ${issue.title}
${issue.body}

Return as structured JSON.`;
    
    const result = await executor.execute(prompt);
    return JSON.parse(result);
  }
}
```

### Step 4: [Removed - Complexity scoring not needed]

### Step 5: Implement Pattern Matcher
Create `src/rmapp/analysis/patterns.ts`:
```typescript
class PatternMatcher {
  async findSimilarImplementations(
    requirements: Requirement[],
    context: RepoContext
  ): Promise<Pattern[]> {
    // Search commit history
    // Find similar PRs
    // Locate comparable code
    // Extract patterns
  }
  
  async suggestImplementationApproach(
    analysis: IssueAnalysis
  ): Promise<ImplementationSuggestion> {
    // Based on patterns
    // Suggest architecture
    // Recommend patterns
    // Identify pitfalls
  }
}
```

### Step 6: Add Context Enrichment
Enhance analysis with context:
```typescript
class ContextEnricher {
  async enrich(analysis: IssueAnalysis): Promise<EnrichedAnalysis> {
    // Add codebase conventions
    // Include recent related changes
    // Add team preferences
    // Include architectural constraints
  }
  
  private async gatherCodebaseContext(): Promise<CodebaseContext> {
    // Analyze file structure
    // Detect frameworks
    // Find coding patterns
    // Identify conventions
  }
}
```

### Step 7: Create Analysis Pipeline
Combine components in `src/rmapp/analysis/pipeline.ts`:
```typescript
class AnalysisPipeline {
  async analyze(issue: GitHubIssue): Promise<IssueAnalysis> {
    // Use Claude Code for comprehensive analysis
    const executor = new ClaudeCodeExecutor(
      {
        allowedTools: ['Read', 'Glob', 'Grep', 'TodoWrite', 'TodoRead'],
        includeDefaultTools: false
      },
      { model: 'sonnet' },
      this.rmplanConfig
    );
    
    const prompt = `Analyze this GitHub issue comprehensively:

1. Parse the issue to extract:
   - Type (feature/bug/refactor/docs/test)
   - Key requirements with priorities
   - Technical scope and affected files

2. Find references:
   - Mentioned files and code
   - Related issues/PRs
   - Documentation links

3. Identify patterns:
   - Similar implementations in the codebase
   - Relevant coding patterns to follow

4. Suggest implementation approach

Issue #${issue.number}: ${issue.title}
${issue.body}

Provide a structured analysis following the IssueAnalysis interface.`;
    
    const result = await executor.execute(prompt);
    return this.parseAnalysisResult(result);
  }
}
```

### Step 8: Add Analysis Caching
Cache analysis results:
```typescript
class AnalysisCache {
  async get(issueId: number): Promise<IssueAnalysis | null>;
  async set(issueId: number, analysis: IssueAnalysis): Promise<void>;
  async invalidate(issueId: number): Promise<void>;
}
```

## Testing Strategy
1. Test parsing various issue formats
2. Test reference extraction accuracy
3. Test complexity scoring
4. Test pattern matching
5. Integration test full pipeline

## Success Criteria
- [ ] Accurately extracts requirements from issues
- [ ] Correctly identifies technical scope
- [ ] Finds relevant code references
- [ ] Generates actionable analysis