# Code Locator

## Overview
Build a system that accurately maps review comments to specific code locations, handling both explicit references and contextual clues.

## Requirements
- Map inline comments to exact code locations
- Resolve symbolic references (function/class names) to locations
- Handle relative references ("the function above", "this method")
- Track code movement between PR iterations
- Support fuzzy matching for changed code

## Implementation Steps

### Step 1: Define Location Types
Create types in `src/rmapp/locator/types.ts`:
```typescript
interface CodeLocation {
  file: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  symbol?: string;
  type: 'function' | 'class' | 'method' | 'variable' | 'block' | 'file';
}

interface LocationContext {
  beforeLines: string[];
  targetLines: string[];
  afterLines: string[];
  indentLevel: number;
  parentSymbols: string[];
}

interface LocationMatch {
  location: CodeLocation;
  confidence: number;
  matchType: 'exact' | 'fuzzy' | 'contextual';
  evidence: string[];
}
```

### Step 2: Build Symbol Index
Implement `src/rmapp/locator/symbol_index.ts`:
```typescript
class SymbolIndex {
  async buildIndex(files: string[]): Promise<void> {
    for (const file of files) {
      const ast = await this.parseFile(file);
      await this.extractSymbols(ast, file);
    }
  }
  
  private async extractSymbols(
    ast: AST,
    file: string
  ): Promise<Symbol[]> {
    const symbols: Symbol[] = [];
    
    // Walk AST to find symbols
    walkAST(ast, {
      visitFunction: (node) => {
        symbols.push({
          name: node.name,
          type: 'function',
          location: this.nodeToLocation(node, file),
          signature: this.getFunctionSignature(node)
        });
      },
      visitClass: (node) => {
        symbols.push({
          name: node.name,
          type: 'class',
          location: this.nodeToLocation(node, file),
          members: this.getClassMembers(node)
        });
      }
      // Continue for other symbol types...
    });
    
    return symbols;
  }
  
  findSymbol(name: string, context?: SearchContext): Symbol[] {
    // Exact matches
    const exact = this.symbols.filter(s => s.name === name);
    
    // Fuzzy matches
    const fuzzy = this.symbols.filter(s => 
      s.name.toLowerCase().includes(name.toLowerCase())
    );
    
    // Rank by context
    return this.rankByContext([...exact, ...fuzzy], context);
  }
}
```

### Step 3: Create Diff Mapper
Build `src/rmapp/locator/diff_mapper.ts`:
```typescript
class DiffMapper {
  constructor(private diff: GitDiff) {
    this.buildLineMapping();
  }
  
  private buildLineMapping(): void {
    // Map old line numbers to new line numbers
    this.oldToNew = new Map<number, number>();
    this.newToOld = new Map<number, number>();
    
    let oldLine = 1;
    let newLine = 1;
    
    for (const hunk of this.diff.hunks) {
      // Process each line in hunk
      for (const line of hunk.lines) {
        if (line.type === 'delete') {
          oldLine++;
        } else if (line.type === 'add') {
          newLine++;
        } else {
          this.oldToNew.set(oldLine, newLine);
          this.newToOld.set(newLine, oldLine);
          oldLine++;
          newLine++;
        }
      }
    }
  }
  
  mapLocation(location: CodeLocation, direction: 'oldToNew' | 'newToOld'): CodeLocation {
    const mapping = direction === 'oldToNew' ? this.oldToNew : this.newToOld;
    
    const newStart = mapping.get(location.startLine);
    const newEnd = mapping.get(location.endLine);
    
    if (!newStart || !newEnd) {
      // Line was added/deleted, find nearest
      return this.findNearestLocation(location, mapping);
    }
    
    return {
      ...location,
      startLine: newStart,
      endLine: newEnd
    };
  }
}
```

### Step 4: Implement Context Matcher
Create `src/rmapp/locator/context_matcher.ts`:
```typescript
class ContextMatcher {
  findByContext(
    searchContext: string,
    file: FileContent
  ): LocationMatch[] {
    const matches: LocationMatch[] = [];
    
    // Split file into logical blocks
    const blocks = this.splitIntoBlocks(file);
    
    for (const block of blocks) {
      const similarity = this.calculateSimilarity(searchContext, block.content);
      
      if (similarity > 0.7) {
        matches.push({
          location: block.location,
          confidence: similarity,
          matchType: 'contextual',
          evidence: this.getMatchEvidence(searchContext, block)
        });
      }
    }
    
    return matches.sort((a, b) => b.confidence - a.confidence);
  }
  
  private calculateSimilarity(context: string, content: string): number {
    // Tokenize both strings
    const contextTokens = this.tokenize(context);
    const contentTokens = this.tokenize(content);
    
    // Calculate various similarities
    const exactMatch = this.exactMatchScore(contextTokens, contentTokens);
    const fuzzyMatch = this.fuzzyMatchScore(contextTokens, contentTokens);
    const structuralMatch = this.structuralMatchScore(context, content);
    
    // Weighted combination
    return (exactMatch * 0.5) + (fuzzyMatch * 0.3) + (structuralMatch * 0.2);
  }
}
```

### Step 5: Build Reference Resolver
Implement `src/rmapp/locator/reference_resolver.ts`:
```typescript
class ReferenceResolver {
  async resolveReference(
    reference: string,
    context: ReviewContext
  ): Promise<LocationMatch[]> {
    const matches: LocationMatch[] = [];
    
    // Try different resolution strategies
    const strategies = [
      this.resolveExplicitReference,
      this.resolveSymbolicReference,
      this.resolveRelativeReference,
      this.resolveContextualReference
    ];
    
    for (const strategy of strategies) {
      const strategyMatches = await strategy.call(this, reference, context);
      matches.push(...strategyMatches);
    }
    
    // Deduplicate and rank
    return this.rankMatches(this.deduplicateMatches(matches));
  }
  
  private async resolveRelativeReference(
    reference: string,
    context: ReviewContext
  ): Promise<LocationMatch[]> {
    const patterns = {
      above: /the\s+(\w+)\s+above/i,
      below: /the\s+(\w+)\s+below/i,
      previous: /previous\s+(\w+)/i,
      next: /next\s+(\w+)/i,
      this: /this\s+(\w+)/i
    };
    
    for (const [direction, pattern] of Object.entries(patterns)) {
      const match = reference.match(pattern);
      if (match) {
        const targetType = match[1];
        return this.findRelativeTarget(
          context.comment.location,
          direction,
          targetType
        );
      }
    }
    
    return [];
  }
}
```

### Step 6: Create Smart Locator
Build `src/rmapp/locator/smart_locator.ts`:
```typescript
class SmartLocator {
  async locate(
    reference: string,
    context: ReviewContext
  ): Promise<CodeLocation> {
    // Get all possible matches
    const matches = await this.findAllMatches(reference, context);
    
    // If no matches, try fuzzy search
    if (matches.length === 0) {
      const fuzzyMatches = await this.fuzzySearch(reference, context);
      matches.push(...fuzzyMatches);
    }
    
    // Still no matches, ask for clarification
    if (matches.length === 0) {
      throw new LocationNotFoundError(reference, this.suggestAlternatives(reference));
    }
    
    // Multiple matches, use context to disambiguate
    if (matches.length > 1) {
      return this.disambiguate(matches, context);
    }
    
    return matches[0].location;
  }
  
  private async disambiguate(
    matches: LocationMatch[],
    context: ReviewContext
  ): Promise<CodeLocation> {
    // Use various signals to pick best match
    const scores = matches.map(match => ({
      match,
      score: this.scoreMatch(match, context)
    }));
    
    // Sort by score
    scores.sort((a, b) => b.score - a.score);
    
    // If top two are close, might need to ask
    if (scores.length > 1 && scores[0].score - scores[1].score < 0.1) {
      console.warn('Ambiguous location reference, picking best match');
    }
    
    return scores[0].match.location;
  }
  
  private scoreMatch(match: LocationMatch, context: ReviewContext): number {
    let score = match.confidence;
    
    // Boost if in changed files
    if (context.diff.changedFiles.includes(match.location.file)) {
      score += 0.2;
    }
    
    // Boost if near other comments
    if (this.isNearOtherComments(match.location, context)) {
      score += 0.1;
    }
    
    // Boost if matches comment patterns
    if (this.matchesCommentPattern(match, context)) {
      score += 0.1;
    }
    
    return Math.min(score, 1.0);
  }
}
```

### Step 7: Add Caching Layer
Create `src/rmapp/locator/cache.ts`:
```typescript
class LocationCache {
  private cache = new Map<string, CachedLocation>();
  
  async get(
    reference: string,
    context: CacheContext
  ): Promise<CodeLocation | null> {
    const key = this.generateKey(reference, context);
    const cached = this.cache.get(key);
    
    if (!cached) return null;
    
    // Validate cache is still valid
    if (await this.isValid(cached, context)) {
      return cached.location;
    }
    
    // Invalidate stale cache
    this.cache.delete(key);
    return null;
  }
  
  set(
    reference: string,
    location: CodeLocation,
    context: CacheContext
  ): void {
    const key = this.generateKey(reference, context);
    this.cache.set(key, {
      location,
      context,
      timestamp: Date.now()
    });
  }
  
  private async isValid(
    cached: CachedLocation,
    currentContext: CacheContext
  ): Promise<boolean> {
    // Check if file has changed
    if (cached.context.fileHash !== currentContext.fileHash) {
      return false;
    }
    
    // Check if too old
    if (Date.now() - cached.timestamp > 3600000) { // 1 hour
      return false;
    }
    
    return true;
  }
}
```

### Step 8: Create Location Service
Combine in `src/rmapp/locator/service.ts`:
```typescript
class LocationService {
  constructor(
    private symbolIndex: SymbolIndex,
    private diffMapper: DiffMapper,
    private contextMatcher: ContextMatcher,
    private resolver: ReferenceResolver,
    private smartLocator: SmartLocator,
    private cache: LocationCache
  ) {}
  
  async locateFromComment(
    comment: ReviewComment,
    pr: PullRequest
  ): Promise<CodeLocation[]> {
    const locations: CodeLocation[] = [];
    
    // Check cache first
    const cached = await this.cache.get(comment.id.toString(), {
      prNumber: pr.number,
      fileHash: await this.getFileHash(pr)
    });
    
    if (cached) {
      return [cached];
    }
    
    // Inline comments have explicit location
    if (comment.type === 'inline' && comment.location) {
      locations.push(comment.location);
    }
    
    // Extract references from comment body
    const references = this.extractReferences(comment.body);
    
    // Resolve each reference
    for (const ref of references) {
      try {
        const location = await this.smartLocator.locate(ref, {
          comment,
          pr,
          diff: await this.getDiff(pr)
        });
        locations.push(location);
      } catch (e) {
        console.warn(`Could not resolve reference: ${ref}`, e);
      }
    }
    
    // Cache results
    for (const location of locations) {
      this.cache.set(comment.id.toString(), location, {
        prNumber: pr.number,
        fileHash: await this.getFileHash(pr)
      });
    }
    
    return locations;
  }
}
```

## Testing Strategy
1. Test symbol extraction accuracy
2. Test diff line mapping
3. Test context matching
4. Test reference resolution
5. Test ambiguous reference handling
6. Performance test with large files

## Success Criteria
- [ ] Accurately maps inline comments to code
- [ ] Resolves symbolic references correctly
- [ ] Handles relative references properly
- [ ] Tracks code through PR changes
- [ ] Provides helpful errors for ambiguous references