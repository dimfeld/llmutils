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
    // Extract mentioned files
    // Find referenced issues/PRs
    // Locate documentation links
    // Identify code snippets
    // Search for similar issues
  }
  
  private async findRelatedCode(description: string): Promise<string[]> {
    // Use rmfind to locate relevant files
    // Search for mentioned class/function names
    // Find files with similar patterns
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
    // Parse issue
    const parsed = await this.parser.parse(issue);
    
    // Extract references
    const references = await this.extractor.extract(issue);
    
    // Skip complexity analysis - not needed
    
    // Find patterns
    const patterns = await this.matcher.findPatterns(parsed);
    
    // Enrich context
    const enriched = await this.enricher.enrich({
      ...parsed,
      patterns
    });
    
    return enriched;
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