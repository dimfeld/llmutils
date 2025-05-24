# Context Gathering

## Overview
Build an intelligent context gathering system that automatically collects relevant information from multiple sources to enhance agent decision-making.

## Requirements
- Gather context from multiple sources (code, docs, issues, PRs)
- Intelligently determine what context is relevant
- Cache and reuse context efficiently
- Provide context ranking and filtering
- Support incremental context updates

## Implementation Steps

### Step 1: Define Context Types
Create types in `src/rmapp/context/types.ts`:
```typescript
interface Context {
  id: string;
  type: ContextType;
  source: ContextSource;
  content: any;
  metadata: ContextMetadata;
  relevance: number;
  timestamp: Date;
}

enum ContextType {
  Code = 'code',
  Documentation = 'documentation',
  Issue = 'issue',
  PullRequest = 'pull_request',
  Commit = 'commit',
  Discussion = 'discussion',
  Example = 'example',
  Pattern = 'pattern'
}

interface ContextSource {
  type: 'file' | 'url' | 'api' | 'search';
  location: string;
  version?: string;
}

interface ContextQuery {
  keywords: string[];
  types?: ContextType[];
  timeRange?: DateRange;
  maxResults?: number;
  minRelevance?: number;
}

interface GatheredContext {
  query: ContextQuery;
  contexts: Context[];
  summary: ContextSummary;
  recommendations: string[];
}
```

### Step 2: Build Context Providers
Implement `src/rmapp/context/providers/base.ts`:
```typescript
abstract class ContextProvider {
  abstract type: ContextType;
  abstract priority: number;
  
  abstract async gather(query: ContextQuery): Promise<Context[]>;
  abstract async validate(context: Context): Promise<boolean>;
  abstract async refresh(context: Context): Promise<Context>;
  
  protected createContext(
    content: any,
    source: ContextSource,
    metadata: ContextMetadata
  ): Context {
    return {
      id: this.generateId(source),
      type: this.type,
      source,
      content,
      metadata,
      relevance: 0, // Will be scored later
      timestamp: new Date()
    };
  }
}

class CodeContextProvider extends ContextProvider {
  type = ContextType.Code;
  priority = 10;
  
  async gather(query: ContextQuery): Promise<Context[]> {
    const contexts: Context[] = [];
    
    // Search for relevant code
    const files = await this.searchCode(query.keywords);
    
    for (const file of files) {
      // Extract relevant sections
      const sections = await this.extractRelevantSections(file, query);
      
      for (const section of sections) {
        contexts.push(this.createContext(
          section,
          { type: 'file', location: file.path },
          {
            language: file.language,
            symbols: section.symbols,
            dependencies: section.dependencies
          }
        ));
      }
    }
    
    return contexts;
  }
  
  private async extractRelevantSections(
    file: CodeFile,
    query: ContextQuery
  ): Promise<CodeSection[]> {
    // Parse AST
    const ast = await this.parseFile(file);
    
    // Find relevant nodes
    const relevantNodes = this.findRelevantNodes(ast, query);
    
    // Extract sections with context
    return relevantNodes.map(node => ({
      code: this.extractNodeWithContext(node),
      symbols: this.extractSymbols(node),
      dependencies: this.extractDependencies(node)
    }));
  }
}
```

### Step 3: Create Context Scorer
Build `src/rmapp/context/scorer.ts`:
```typescript
class ContextScorer {
  private scorers: Map<ContextType, Scorer> = new Map();
  
  constructor() {
    this.registerScorers();
  }
  
  scoreContext(context: Context, query: ContextQuery): number {
    const scorer = this.scorers.get(context.type);
    if (!scorer) return 0;
    
    // Calculate component scores
    const keywordScore = this.calculateKeywordScore(context, query);
    const freshnessScore = this.calculateFreshnessScore(context);
    const qualityScore = scorer.calculateQualityScore(context);
    const relevanceScore = scorer.calculateRelevanceScore(context, query);
    
    // Weighted combination
    return (
      keywordScore * 0.3 +
      freshnessScore * 0.1 +
      qualityScore * 0.2 +
      relevanceScore * 0.4
    );
  }
  
  private calculateKeywordScore(
    context: Context,
    query: ContextQuery
  ): number {
    const content = JSON.stringify(context.content).toLowerCase();
    const keywords = query.keywords.map(k => k.toLowerCase());
    
    let score = 0;
    let totalWeight = 0;
    
    for (let i = 0; i < keywords.length; i++) {
      const keyword = keywords[i];
      const weight = 1 / (i + 1); // Higher weight for earlier keywords
      
      // Count occurrences
      const occurrences = (content.match(new RegExp(keyword, 'g')) || []).length;
      
      if (occurrences > 0) {
        score += weight * Math.min(occurrences / 10, 1);
      }
      
      totalWeight += weight;
    }
    
    return score / totalWeight;
  }
  
  private calculateFreshnessScore(context: Context): number {
    const age = Date.now() - context.timestamp.getTime();
    const dayInMs = 24 * 60 * 60 * 1000;
    
    // Exponential decay
    return Math.exp(-age / (30 * dayInMs)); // 30-day half-life
  }
}

class CodeScorer implements Scorer {
  calculateQualityScore(context: Context): number {
    const code = context.content;
    
    // Check for quality indicators
    const hasTests = code.includes('test') || code.includes('spec');
    const hasComments = this.calculateCommentRatio(code) > 0.1;
    const hasTypes = code.includes(':') || code.includes('interface');
    const isWellFormatted = this.checkFormatting(code);
    
    let score = 0;
    if (hasTests) score += 0.25;
    if (hasComments) score += 0.25;
    if (hasTypes) score += 0.25;
    if (isWellFormatted) score += 0.25;
    
    return score;
  }
  
  calculateRelevanceScore(
    context: Context,
    query: ContextQuery
  ): number {
    // Check if context contains relevant patterns
    const patterns = this.extractPatterns(context);
    const queryPatterns = this.inferPatterns(query);
    
    return this.calculatePatternSimilarity(patterns, queryPatterns);
  }
}
```

### Step 4: Implement Context Aggregator
Create `src/rmapp/context/aggregator.ts`:
```typescript
class ContextAggregator {
  aggregate(contexts: Context[]): AggregatedContext {
    // Group by type
    const byType = this.groupByType(contexts);
    
    // Extract key information
    const symbols = this.extractAllSymbols(contexts);
    const patterns = this.extractPatterns(contexts);
    const examples = this.extractExamples(contexts);
    
    // Build knowledge graph
    const graph = this.buildKnowledgeGraph(contexts);
    
    // Generate insights
    const insights = this.generateInsights(byType, graph);
    
    return {
      byType,
      symbols,
      patterns,
      examples,
      graph,
      insights,
      summary: this.generateSummary(contexts)
    };
  }
  
  private buildKnowledgeGraph(contexts: Context[]): KnowledgeGraph {
    const graph = new KnowledgeGraph();
    
    // Add nodes
    for (const context of contexts) {
      graph.addNode({
        id: context.id,
        type: context.type,
        label: this.getLabel(context),
        data: context
      });
    }
    
    // Add edges based on relationships
    for (const context of contexts) {
      // Find related contexts
      const related = this.findRelated(context, contexts);
      
      for (const relatedContext of related) {
        graph.addEdge({
          from: context.id,
          to: relatedContext.id,
          type: this.inferRelationType(context, relatedContext),
          weight: this.calculateRelationStrength(context, relatedContext)
        });
      }
    }
    
    return graph;
  }
  
  private generateInsights(
    byType: Map<ContextType, Context[]>,
    graph: KnowledgeGraph
  ): Insight[] {
    const insights: Insight[] = [];
    
    // Pattern insights
    const codeContexts = byType.get(ContextType.Code) || [];
    if (codeContexts.length > 0) {
      const commonPatterns = this.findCommonPatterns(codeContexts);
      insights.push({
        type: 'pattern',
        title: 'Common Code Patterns',
        description: `Found ${commonPatterns.length} recurring patterns`,
        data: commonPatterns
      });
    }
    
    // Relationship insights
    const strongRelationships = graph.getStrongRelationships(0.8);
    if (strongRelationships.length > 0) {
      insights.push({
        type: 'relationship',
        title: 'Strong Relationships',
        description: 'Highly related contexts that should be considered together',
        data: strongRelationships
      });
    }
    
    // Coverage insights
    const coverage = this.analyzeCoverage(byType);
    insights.push({
      type: 'coverage',
      title: 'Context Coverage',
      description: 'Areas with good/poor context coverage',
      data: coverage
    });
    
    return insights;
  }
}
```

### Step 5: Build Context Cache
Implement `src/rmapp/context/cache.ts`:
```typescript
class ContextCache {
  private memoryCache = new LRUCache<string, Context>({
    max: 1000,
    ttl: 1000 * 60 * 60 // 1 hour
  });
  
  private persistentCache: PersistentCache;
  
  async get(key: string): Promise<Context | null> {
    // Check memory cache
    const memCached = this.memoryCache.get(key);
    if (memCached) {
      return memCached;
    }
    
    // Check persistent cache
    const persisted = await this.persistentCache.get(key);
    if (persisted) {
      // Validate it's still fresh
      if (await this.isFresh(persisted)) {
        // Add to memory cache
        this.memoryCache.set(key, persisted);
        return persisted;
      }
    }
    
    return null;
  }
  
  async set(key: string, context: Context): Promise<void> {
    // Add to memory cache
    this.memoryCache.set(key, context);
    
    // Persist if important
    if (this.shouldPersist(context)) {
      await this.persistentCache.set(key, context);
    }
  }
  
  async invalidate(pattern: string | RegExp): Promise<number> {
    let count = 0;
    
    // Invalidate memory cache
    for (const [key, _] of this.memoryCache.entries()) {
      if (this.matchesPattern(key, pattern)) {
        this.memoryCache.delete(key);
        count++;
      }
    }
    
    // Invalidate persistent cache
    count += await this.persistentCache.invalidate(pattern);
    
    return count;
  }
  
  private shouldPersist(context: Context): boolean {
    // Persist high-value contexts
    return (
      context.relevance > 0.8 ||
      context.type === ContextType.Documentation ||
      context.metadata.isPinned
    );
  }
}
```

### Step 6: Create Context Recommender
Build `src/rmapp/context/recommender.ts`:
```typescript
class ContextRecommender {
  recommend(
    current: Context[],
    available: Context[]
  ): RecommendedContext[] {
    const recommendations: RecommendedContext[] = [];
    
    // Analyze what we have
    const analysis = this.analyzeCurrentContext(current);
    
    // Find gaps
    const gaps = this.identifyGaps(analysis);
    
    // Score available contexts for filling gaps
    for (const context of available) {
      const score = this.scoreForGaps(context, gaps);
      
      if (score > 0.5) {
        recommendations.push({
          context,
          reason: this.explainRecommendation(context, gaps),
          score,
          priority: this.calculatePriority(context, gaps)
        });
      }
    }
    
    // Sort by priority
    recommendations.sort((a, b) => b.priority - a.priority);
    
    return recommendations.slice(0, 10); // Top 10
  }
  
  private identifyGaps(analysis: ContextAnalysis): Gap[] {
    const gaps: Gap[] = [];
    
    // Check for missing context types
    const missingTypes = this.getMissingTypes(analysis);
    for (const type of missingTypes) {
      gaps.push({
        type: 'missing_type',
        value: type,
        importance: this.getTypeImportance(type)
      });
    }
    
    // Check for incomplete coverage
    if (analysis.codeCoverage < 0.7) {
      gaps.push({
        type: 'low_coverage',
        value: 'code',
        importance: 0.8
      });
    }
    
    // Check for outdated context
    const outdated = analysis.contexts.filter(c => 
      this.isOutdated(c)
    );
    if (outdated.length > 0) {
      gaps.push({
        type: 'outdated',
        value: outdated.map(c => c.id),
        importance: 0.6
      });
    }
    
    return gaps;
  }
  
  private explainRecommendation(
    context: Context,
    gaps: Gap[]
  ): string {
    const reasons: string[] = [];
    
    for (const gap of gaps) {
      if (this.contextFillsGap(context, gap)) {
        reasons.push(this.getGapExplanation(gap));
      }
    }
    
    return reasons.join('; ');
  }
}
```

### Step 7: Implement Smart Search
Create `src/rmapp/context/search.ts`:
```typescript
class SmartContextSearch {
  async search(
    query: ContextQuery,
    options: SearchOptions = {}
  ): Promise<SearchResult> {
    // Expand query with synonyms and related terms
    const expandedQuery = await this.expandQuery(query);
    
    // Search across all providers
    const searchPromises = this.providers.map(provider =>
      provider.gather(expandedQuery)
    );
    
    const providerResults = await Promise.all(searchPromises);
    const allContexts = providerResults.flat();
    
    // Score and rank
    const scored = allContexts.map(context => ({
      context,
      score: this.scorer.score(context, expandedQuery)
    }));
    
    // Apply filters
    const filtered = this.applyFilters(scored, options.filters);
    
    // Sort by score
    filtered.sort((a, b) => b.score - a.score);
    
    // Apply limits
    const limited = filtered.slice(0, options.limit || 50);
    
    // Generate facets for filtering
    const facets = this.generateFacets(filtered);
    
    return {
      query: expandedQuery,
      results: limited.map(s => s.context),
      totalCount: allContexts.length,
      facets,
      suggestions: this.generateSuggestions(limited, expandedQuery)
    };
  }
  
  private async expandQuery(query: ContextQuery): Promise<ContextQuery> {
    const expanded = { ...query };
    
    // Add synonyms
    expanded.keywords = [...query.keywords];
    for (const keyword of query.keywords) {
      const synonyms = await this.getSynonyms(keyword);
      expanded.keywords.push(...synonyms);
    }
    
    // Add related terms
    const related = await this.getRelatedTerms(query.keywords);
    expanded.keywords.push(...related);
    
    // Remove duplicates
    expanded.keywords = [...new Set(expanded.keywords)];
    
    return expanded;
  }
  
  private generateFacets(results: ScoredContext[]): Facet[] {
    const facets: Facet[] = [];
    
    // Type facet
    const typeCounts = new Map<ContextType, number>();
    for (const result of results) {
      const count = typeCounts.get(result.context.type) || 0;
      typeCounts.set(result.context.type, count + 1);
    }
    
    facets.push({
      name: 'type',
      values: Array.from(typeCounts.entries()).map(([type, count]) => ({
        value: type,
        count,
        label: this.getTypeLabel(type)
      }))
    });
    
    // Time facet
    facets.push({
      name: 'time',
      values: [
        { value: 'today', count: this.countByTime(results, 'today'), label: 'Today' },
        { value: 'week', count: this.countByTime(results, 'week'), label: 'This Week' },
        { value: 'month', count: this.countByTime(results, 'month'), label: 'This Month' }
      ]
    });
    
    return facets;
  }
}
```

### Step 8: Create Context Pipeline
Combine in `src/rmapp/context/pipeline.ts`:
```typescript
class ContextGatheringPipeline {
  constructor(
    private providers: ContextProvider[],
    private scorer: ContextScorer,
    private aggregator: ContextAggregator,
    private cache: ContextCache,
    private recommender: ContextRecommender,
    private search: SmartContextSearch
  ) {}
  
  async gatherContext(
    request: ContextRequest
  ): Promise<GatheredContext> {
    // Check cache first
    const cacheKey = this.generateCacheKey(request);
    const cached = await this.cache.get(cacheKey);
    if (cached && !request.skipCache) {
      return cached;
    }
    
    // Build query
    const query = this.buildQuery(request);
    
    // Search for context
    const searchResult = await this.search.search(query, {
      limit: 100,
      filters: request.filters
    });
    
    // Score results
    const scored = searchResult.results.map(context => ({
      ...context,
      relevance: this.scorer.score(context, query)
    }));
    
    // Filter by relevance
    const relevant = scored.filter(c => 
      c.relevance >= (request.minRelevance || 0.5)
    );
    
    // Aggregate
    const aggregated = this.aggregator.aggregate(relevant);
    
    // Get recommendations
    const recommendations = this.recommender.recommend(
      relevant,
      searchResult.results.filter(r => !relevant.includes(r))
    );
    
    // Build result
    const result: GatheredContext = {
      query,
      contexts: relevant,
      summary: aggregated.summary,
      insights: aggregated.insights,
      recommendations: recommendations.map(r => r.reason),
      metadata: {
        totalSearched: searchResult.totalCount,
        totalRelevant: relevant.length,
        searchTime: Date.now() - startTime
      }
    };
    
    // Cache result
    await this.cache.set(cacheKey, result);
    
    return result;
  }
}
```

## Testing Strategy
1. Test context provider accuracy
2. Test scoring algorithms
3. Test aggregation logic
4. Test cache behavior
5. Test recommendation quality
6. Performance test with large contexts

## Success Criteria
- [ ] Gathers relevant context efficiently
- [ ] Scores context accurately
- [ ] Provides useful recommendations
- [ ] Caches effectively
- [ ] Scales to large codebases