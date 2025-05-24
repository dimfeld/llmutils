# Review Parser

## Overview
Build a system to parse and understand code review comments, extracting actionable change requests from natural language.

## Requirements
- Parse different types of review comments (inline, general, suggestions)
- Extract specific change requests from natural language
- Understand context and scope of requested changes
- Categorize review feedback (must-fix, suggestion, question)
- Handle batch review processing

## Implementation Steps

### Step 1: Define Review Data Model
Create types in `src/rmapp/reviews/types.ts`:
```typescript
interface ReviewComment {
  id: number;
  type: 'inline' | 'general' | 'suggestion';
  body: string;
  location?: CodeLocation;
  thread?: ReviewThread;
  author: string;
  createdAt: Date;
  resolved: boolean;
}

interface ParsedReview {
  comment: ReviewComment;
  intent: ReviewIntent;
  changeRequests: ChangeRequest[];
  questions: Question[];
  context: ReviewContext;
}

interface ChangeRequest {
  type: 'add' | 'modify' | 'remove' | 'refactor';
  description: string;
  location: CodeLocation;
  priority: 'required' | 'suggested' | 'optional';
  suggestedCode?: string;
  rationale?: string;
}

enum ReviewIntent {
  RequestChanges = 'request_changes',
  Suggestion = 'suggestion',
  Question = 'question',
  Approval = 'approval',
  Comment = 'comment'
}
```

### Step 2: Create Natural Language Parser
Implement `src/rmapp/reviews/nlp_parser.ts`:
```typescript
class ReviewNLPParser {
  private patterns = {
    request: [
      /please\s+(add|implement|create)/i,
      /can you\s+(add|change|modify)/i,
      /should\s+(have|include|handle)/i,
      /needs?\s+(to|a|an)/i,
      /missing\s+\w+/i
    ],
    suggestion: [
      /consider\s+/i,
      /might\s+be\s+better/i,
      /suggest\s+/i,
      /alternatively/i,
      /optional:/i
    ],
    question: [
      /why\s+(did|does|is)/i,
      /what\s+(is|does|about)/i,
      /how\s+(does|is|about)/i,
      /\?$/
    ]
  };
  
  parseIntent(comment: string): ReviewIntent {
    // Check for explicit markers
    if (comment.includes('LGTM')) return ReviewIntent.Approval;
    if (comment.includes('❓')) return ReviewIntent.Question;
    
    // Pattern matching
    for (const [intent, patterns] of Object.entries(this.patterns)) {
      if (patterns.some(p => p.test(comment))) {
        return intent as ReviewIntent;
      }
    }
    
    return ReviewIntent.Comment;
  }
  
  extractChangeRequests(comment: string): ChangeRequest[] {
    const requests: ChangeRequest[] = [];
    
    // Split into sentences
    const sentences = this.splitSentences(comment);
    
    for (const sentence of sentences) {
      const request = this.parseChangeRequest(sentence);
      if (request) {
        requests.push(request);
      }
    }
    
    return requests;
  }
}
```

### Step 3: Build Code Reference Resolver
Create `src/rmapp/reviews/reference_resolver.ts`:
```typescript
class CodeReferenceResolver {
  async resolveReferences(
    comment: ReviewComment,
    pr: PullRequest
  ): Promise<CodeLocation[]> {
    const locations: CodeLocation[] = [];
    
    // Inline comments have explicit location
    if (comment.location) {
      locations.push(comment.location);
    }
    
    // Extract code references from text
    const textRefs = this.extractTextReferences(comment.body);
    for (const ref of textRefs) {
      const location = await this.resolveReference(ref, pr);
      if (location) {
        locations.push(location);
      }
    }
    
    // Use context from thread
    if (comment.thread) {
      const threadLocs = await this.getThreadLocations(comment.thread);
      locations.push(...threadLocs);
    }
    
    return locations;
  }
  
  private extractTextReferences(text: string): TextReference[] {
    const refs: TextReference[] = [];
    
    // Function/class names
    const codeNames = text.match(/`(\w+)`/g) || [];
    refs.push(...codeNames.map(n => ({ type: 'symbol', value: n })));
    
    // File paths
    const filePaths = text.match(/[\w/]+\.\w+/g) || [];
    refs.push(...filePaths.map(p => ({ type: 'file', value: p })));
    
    // Line numbers
    const lineRefs = text.match(/line\s+(\d+)/gi) || [];
    refs.push(...lineRefs.map(l => ({ type: 'line', value: l })));
    
    return refs;
  }
}
```

### Step 4: Implement Change Request Analyzer
Create `src/rmapp/reviews/change_analyzer.ts`:
```typescript
class ChangeRequestAnalyzer {
  analyzeRequest(
    request: ChangeRequest,
    context: ReviewContext
  ): AnalyzedChange {
    // Determine change type
    const changeType = this.inferChangeType(request);
    
    // Estimate complexity
    const complexity = this.estimateComplexity(request, context);
    
    // Find similar patterns
    const patterns = this.findPatterns(request, context);
    
    // Generate implementation approach
    const approach = this.suggestApproach(request, patterns);
    
    return {
      ...request,
      changeType,
      complexity,
      patterns,
      approach,
      estimatedLOC: this.estimateLinesOfChange(request)
    };
  }
  
  private inferChangeType(request: ChangeRequest): ChangeType {
    const keywords = {
      errorHandling: ['error', 'exception', 'try', 'catch', 'handle'],
      validation: ['validate', 'check', 'verify', 'ensure'],
      logging: ['log', 'debug', 'trace', 'console'],
      testing: ['test', 'spec', 'assert', 'expect'],
      documentation: ['comment', 'doc', 'jsdoc', 'readme'],
      refactoring: ['refactor', 'extract', 'rename', 'move']
    };
    
    // Match request against keywords
    for (const [type, words] of Object.entries(keywords)) {
      if (words.some(w => request.description.toLowerCase().includes(w))) {
        return type as ChangeType;
      }
    }
    
    return 'general';
  }
}
```

### Step 5: Create Context Builder
Implement `src/rmapp/reviews/context_builder.ts`:
```typescript
class ReviewContextBuilder {
  async buildContext(
    comment: ReviewComment,
    pr: PullRequest
  ): Promise<ReviewContext> {
    // Get PR diff
    const diff = await this.getPRDiff(pr);
    
    // Get file content
    const files = await this.getRelevantFiles(comment, pr);
    
    // Get related comments
    const thread = await this.getCommentThread(comment);
    
    // Get PR description
    const prContext = await this.getPRContext(pr);
    
    // Get commit messages
    const commits = await this.getCommits(pr);
    
    return {
      comment,
      diff,
      files,
      thread,
      prContext,
      commits,
      metadata: {
        prNumber: pr.number,
        author: comment.author,
        timestamp: comment.createdAt
      }
    };
  }
  
  private async getRelevantFiles(
    comment: ReviewComment,
    pr: PullRequest
  ): Promise<FileContent[]> {
    const files: FileContent[] = [];
    
    // Files mentioned in comment
    if (comment.location) {
      files.push(await this.getFile(comment.location.path));
    }
    
    // Files in same directory
    const relatedFiles = await this.findRelatedFiles(comment);
    files.push(...relatedFiles);
    
    return files;
  }
}
```

### Step 6: Build Review Grouper
Create `src/rmapp/reviews/grouper.ts`:
```typescript
class ReviewGrouper {
  groupReviews(reviews: ParsedReview[]): GroupedReviews {
    const groups = {
      byFile: new Map<string, ParsedReview[]>(),
      byType: new Map<ChangeType, ParsedReview[]>(),
      byPriority: new Map<Priority, ParsedReview[]>(),
      byAuthor: new Map<string, ParsedReview[]>()
    };
    
    for (const review of reviews) {
      // Group by file
      for (const location of review.locations) {
        if (!groups.byFile.has(location.file)) {
          groups.byFile.set(location.file, []);
        }
        groups.byFile.get(location.file)!.push(review);
      }
      
      // Group by type
      if (!groups.byType.has(review.changeType)) {
        groups.byType.set(review.changeType, []);
      }
      groups.byType.get(review.changeType)!.push(review);
      
      // Continue for other groupings...
    }
    
    return groups;
  }
  
  prioritizeGroups(groups: GroupedReviews): PrioritizedGroups {
    // Required changes first
    // Then by complexity (simple first)
    // Then by dependencies
    // Then by file locality
  }
}
```

### Step 7: Create Suggestion Handler
Implement `src/rmapp/reviews/suggestions.ts`:
```typescript
class SuggestionHandler {
  async processSuggestion(
    suggestion: GitHubSuggestion
  ): Promise<ProcessedSuggestion> {
    // Parse GitHub suggestion format
    const parsed = this.parseSuggestionBlock(suggestion.body);
    
    // Validate suggestion
    const validation = await this.validateSuggestion(parsed);
    
    // Enhance with context
    const enhanced = await this.enhanceSuggestion(parsed);
    
    return {
      original: suggestion,
      parsed,
      validation,
      enhanced,
      canAutoApply: validation.isValid && !validation.hasConflicts
    };
  }
  
  private parseSuggestionBlock(body: string): ParsedSuggestion {
    // Extract ```suggestion blocks
    const suggestionMatch = body.match(/```suggestion\n([\s\S]+?)\n```/);
    
    if (!suggestionMatch) {
      return null;
    }
    
    return {
      suggestedCode: suggestionMatch[1],
      startLine: this.extractLineNumber(body),
      endLine: this.extractEndLine(body)
    };
  }
}
```

### Step 8: Build Review Pipeline
Combine in `src/rmapp/reviews/pipeline.ts`:
```typescript
class ReviewParsingPipeline {
  async parseReviews(
    pr: PullRequest
  ): Promise<ParsedReviewSet> {
    // Fetch all review comments
    const comments = await this.fetchReviewComments(pr);
    
    // Parse each comment
    const parsed: ParsedReview[] = [];
    
    for (const comment of comments) {
      // Build context
      const context = await this.contextBuilder.build(comment, pr);
      
      // Parse intent and requests
      const intent = this.nlpParser.parseIntent(comment.body);
      const requests = this.nlpParser.extractChangeRequests(comment.body);
      
      // Resolve code locations
      const locations = await this.resolver.resolveReferences(comment, pr);
      
      // Analyze changes
      const analyzed = requests.map(r => 
        this.analyzer.analyze(r, context)
      );
      
      parsed.push({
        comment,
        intent,
        changeRequests: analyzed,
        context,
        locations
      });
    }
    
    // Group reviews
    const grouped = this.grouper.group(parsed);
    
    // Prioritize
    const prioritized = this.grouper.prioritize(grouped);
    
    return {
      reviews: parsed,
      grouped: prioritized,
      summary: this.generateSummary(parsed)
    };
  }
}
```

## Testing Strategy
1. Test NLP parsing accuracy
2. Test code reference resolution
3. Test change type detection
4. Test suggestion parsing
5. Integration test full pipeline
6. Test with real review comments

## Success Criteria
- [ ] Accurately parses review intent
- [ ] Extracts actionable changes correctly
- [ ] Resolves code locations properly
- [ ] Groups related reviews effectively
- [ ] Handles suggestions appropriately