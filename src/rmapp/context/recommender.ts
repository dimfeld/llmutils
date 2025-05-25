import type { 
  Context, 
  AggregatedContext, 
  KnowledgeGraph,
  ScoredContext 
} from './types.js';
import { ContextScorer } from './scorer.js';

interface Recommendation {
  context: Context;
  reason: string;
  score: number;
  relationship?: string;
}

interface RecommendationOptions {
  maxRecommendations?: number;
  minScore?: number;
  includeTypes?: string[];
  excludeTypes?: string[];
  boostRelated?: boolean;
}

export class ContextRecommender {
  private scorer: ContextScorer;
  private historyWindow: number;
  private recentContexts: Context[];

  constructor(
    scorer: ContextScorer,
    options: {
      historyWindow?: number;
    } = {}
  ) {
    this.scorer = scorer;
    this.historyWindow = options.historyWindow || 10;
    this.recentContexts = [];
  }

  // Track context usage for better recommendations
  trackUsage(context: Context): void {
    this.recentContexts.push(context);
    if (this.recentContexts.length > this.historyWindow) {
      this.recentContexts.shift();
    }
  }

  // Recommend contexts based on current context
  async recommendFromContext(
    currentContext: Context,
    availableContexts: Context[],
    options: RecommendationOptions = {}
  ): Promise<Recommendation[]> {
    const recommendations: Recommendation[] = [];
    
    // Filter by type if specified
    let candidates = this.filterByType(availableContexts, options);
    
    // Score each candidate
    for (const candidate of candidates) {
      if (this.isSameContext(currentContext, candidate)) continue;
      
      const score = await this.calculateRecommendationScore(
        currentContext, 
        candidate,
        options
      );
      
      if (score >= (options.minScore || 0.3)) {
        const reason = this.generateReason(currentContext, candidate, score);
        recommendations.push({
          context: candidate,
          reason,
          score,
          relationship: this.detectRelationship(currentContext, candidate)
        });
      }
    }

    // Sort by score and limit
    return recommendations
      .sort((a, b) => b.score - a.score)
      .slice(0, options.maxRecommendations || 10);
  }

  // Recommend based on aggregated context
  async recommendFromAggregated(
    aggregated: AggregatedContext,
    availableContexts: Context[],
    options: RecommendationOptions = {}
  ): Promise<Recommendation[]> {
    const allRecommendations = new Map<string, Recommendation>();
    
    // Get recommendations for each context in the aggregate
    const allContexts: Context[] = [];
    for (const contexts of aggregated.byType.values()) {
      allContexts.push(...contexts);
    }
    
    for (const context of allContexts) {
      const recs = await this.recommendFromContext(
        context, 
        availableContexts, 
        { ...options, maxRecommendations: 20 }
      );
      
      // Merge recommendations, keeping highest score
      for (const rec of recs) {
        const key = this.getContextKey(rec.context);
        const existing = allRecommendations.get(key);
        
        if (!existing || rec.score > existing.score) {
          allRecommendations.set(key, rec);
        }
      }
    }

    // Also use graph relationships
    if (aggregated.graph) {
      const graphRecs = this.recommendFromGraph(
        aggregated.graph,
        availableContexts,
        options
      );
      
      for (const rec of graphRecs) {
        const key = this.getContextKey(rec.context);
        const existing = allRecommendations.get(key);
        
        if (!existing || rec.score > existing.score) {
          allRecommendations.set(key, rec);
        }
      }
    }

    return Array.from(allRecommendations.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, options.maxRecommendations || 10);
  }

  // Recommend based on query
  async recommendFromQuery(
    query: string,
    availableContexts: Context[],
    options: RecommendationOptions = {}
  ): Promise<Recommendation[]> {
    const recommendations: Recommendation[] = [];
    let candidates = this.filterByType(availableContexts, options);
    
    // Extract keywords and concepts from query
    const keywords = this.extractKeywords(query);
    const concepts = this.extractConcepts(query);
    
    for (const candidate of candidates) {
      const score = this.scoreAgainstQuery(
        candidate,
        query,
        keywords,
        concepts
      );
      
      if (score >= (options.minScore || 0.3)) {
        recommendations.push({
          context: candidate,
          reason: `Matches query terms: ${keywords.join(', ')}`,
          score
        });
      }
    }

    // Boost based on recent usage patterns
    if (options.boostRelated) {
      this.boostRelatedContexts(recommendations);
    }

    return recommendations
      .sort((a, b) => b.score - a.score)
      .slice(0, options.maxRecommendations || 10);
  }

  // Recommend missing contexts
  detectMissingContexts(
    current: AggregatedContext,
    availableContexts: Context[]
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];
    
    // Check for missing imports
    const importedFiles = this.extractImportedFiles(current);
    const allContexts: Context[] = [];
    for (const contexts of current.byType.values()) {
      allContexts.push(...contexts);
    }
    const currentFiles = new Set(
      allContexts
        .filter((c: Context) => c.type === 'code')
        .map((c: Context) => c.metadata?.file)
        .filter(Boolean)
    );
    
    for (const file of importedFiles) {
      if (!currentFiles.has(file)) {
        const context = availableContexts.find(
          c => c.type === 'code' && c.metadata?.file === file
        );
        
        if (context) {
          recommendations.push({
            context,
            reason: `Imported by included files`,
            score: 0.8
          });
        }
      }
    }

    // Check for missing test files
    const hasImplementation = allContexts.some(
      (c: Context) => c.type === 'code' && !c.metadata?.file?.includes('.test.')
    );
    const hasTests = allContexts.some(
      (c: Context) => c.type === 'code' && c.metadata?.file?.includes('.test.')
    );
    
    if (hasImplementation && !hasTests) {
      const testFiles = availableContexts.filter(
        c => c.type === 'code' && 
        c.metadata?.file?.includes('.test.') &&
        this.isRelatedTestFile(c, current)
      );
      
      for (const testFile of testFiles) {
        recommendations.push({
          context: testFile,
          reason: 'Related test file',
          score: 0.7
        });
      }
    }

    // Check for missing documentation
    if (!current.contexts.some(c => c.type === 'documentation')) {
      const docs = availableContexts.filter(
        c => c.type === 'documentation' &&
        this.isRelatedDocumentation(c, current)
      );
      
      for (const doc of docs) {
        recommendations.push({
          context: doc,
          reason: 'Related documentation',
          score: 0.6
        });
      }
    }

    return recommendations;
  }

  // Private methods
  private filterByType(
    contexts: Context[],
    options: RecommendationOptions
  ): Context[] {
    let filtered = contexts;
    
    if (options.includeTypes?.length) {
      filtered = filtered.filter(c => 
        options.includeTypes!.includes(c.type)
      );
    }
    
    if (options.excludeTypes?.length) {
      filtered = filtered.filter(c => 
        !options.excludeTypes!.includes(c.type)
      );
    }
    
    return filtered;
  }

  private async calculateRecommendationScore(
    current: Context,
    candidate: Context,
    options: RecommendationOptions
  ): Promise<number> {
    let score = 0;
    
    // Base similarity score
    const similarity = await this.scorer.calculateSimilarity(current, candidate);
    score += similarity * 0.4;
    
    // Type compatibility
    if (this.areTypesCompatible(current.type, candidate.type)) {
      score += 0.1;
    }
    
    // Relationship bonus
    const relationship = this.detectRelationship(current, candidate);
    if (relationship) {
      score += this.getRelationshipBonus(relationship);
    }
    
    // Recency bonus
    if (this.wasRecentlyUsedTogether(current, candidate)) {
      score += 0.15;
    }
    
    // Boost related contexts
    if (options.boostRelated && this.areRelated(current, candidate)) {
      score *= 1.2;
    }
    
    return Math.min(score, 1.0);
  }

  private detectRelationship(context1: Context, context2: Context): string | undefined {
    // File relationships
    if (context1.type === 'code' && context2.type === 'code') {
      const file1 = context1.metadata?.file;
      const file2 = context2.metadata?.file;
      
      if (file1 && file2) {
        if (file2.includes('.test.') && file2.includes(path.basename(file1, path.extname(file1)))) {
          return 'test_file';
        }
        if (path.dirname(file1) === path.dirname(file2)) {
          return 'same_directory';
        }
      }
    }
    
    // GitHub relationships
    if (context1.type === 'github' && context2.type === 'github') {
      if (context1.metadata?.pr === context2.metadata?.pr) {
        return 'same_pr';
      }
      if (context1.metadata?.issue === context2.metadata?.issue) {
        return 'same_issue';
      }
    }
    
    // Cross-type relationships
    if (context1.type === 'github' && context2.type === 'code') {
      if (context1.content.includes(context2.metadata?.file || '')) {
        return 'mentioned_file';
      }
    }
    
    return undefined;
  }

  private getRelationshipBonus(relationship: string): number {
    const bonuses: Record<string, number> = {
      'test_file': 0.25,
      'same_directory': 0.15,
      'same_pr': 0.3,
      'same_issue': 0.3,
      'mentioned_file': 0.2
    };
    
    return bonuses[relationship] || 0.1;
  }

  private recommendFromGraph(
    graph: KnowledgeGraph,
    availableContexts: Context[],
    options: RecommendationOptions
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];
    
    // Find highly connected nodes
    const connectionCounts = new Map<string, number>();
    for (const edge of graph.edges) {
      connectionCounts.set(
        edge.to, 
        (connectionCounts.get(edge.to) || 0) + 1
      );
    }
    
    // Recommend highly connected contexts
    for (const [nodeId, count] of connectionCounts.entries()) {
      if (count >= 3) { // Arbitrary threshold
        const node = graph.nodes.find(n => n.id === nodeId);
        if (node) {
          const context = availableContexts.find(c => 
            this.getContextKey(c) === nodeId
          );
          
          if (context) {
            recommendations.push({
              context,
              reason: `Highly connected (${count} relationships)`,
              score: Math.min(count * 0.15, 0.9)
            });
          }
        }
      }
    }
    
    return recommendations;
  }

  private scoreAgainstQuery(
    context: Context,
    query: string,
    keywords: string[],
    concepts: string[]
  ): number {
    let score = 0;
    const lowerContent = context.content.toLowerCase();
    const lowerQuery = query.toLowerCase();
    
    // Direct substring match
    if (lowerContent.includes(lowerQuery)) {
      score += 0.3;
    }
    
    // Keyword matches
    const keywordMatches = keywords.filter(k => 
      lowerContent.includes(k.toLowerCase())
    ).length;
    score += (keywordMatches / keywords.length) * 0.3;
    
    // Concept matches
    const conceptMatches = concepts.filter(c => 
      lowerContent.includes(c.toLowerCase())
    ).length;
    score += (conceptMatches / concepts.length) * 0.2;
    
    // Metadata matches
    if (context.metadata) {
      const metadataStr = JSON.stringify(context.metadata).toLowerCase();
      if (metadataStr.includes(lowerQuery)) {
        score += 0.2;
      }
    }
    
    return Math.min(score, 1.0);
  }

  private extractKeywords(query: string): string[] {
    // Simple keyword extraction
    return query
      .toLowerCase()
      .split(/\s+/)
      .filter(word => 
        word.length > 2 && 
        !['the', 'and', 'or', 'in', 'on', 'at', 'to', 'for'].includes(word)
      );
  }

  private extractConcepts(query: string): string[] {
    // Extract programming concepts
    const concepts: string[] = [];
    
    const conceptPatterns = [
      /\b(class|function|method|interface|type)\s+(\w+)/gi,
      /\b(error|exception|bug|issue)\b/gi,
      /\b(test|tests|testing|spec)\b/gi,
      /\b(import|export|module|package)\b/gi
    ];
    
    for (const pattern of conceptPatterns) {
      const matches = query.matchAll(pattern);
      for (const match of matches) {
        concepts.push(match[0]);
      }
    }
    
    return concepts;
  }

  private boostRelatedContexts(recommendations: Recommendation[]): void {
    // Boost based on recent usage patterns
    for (const rec of recommendations) {
      const recentlyUsedWith = this.recentContexts.filter(recent =>
        this.areRelated(recent, rec.context)
      ).length;
      
      if (recentlyUsedWith > 0) {
        rec.score *= (1 + recentlyUsedWith * 0.1);
        rec.reason += ` (recently used ${recentlyUsedWith} times)`;
      }
    }
  }

  private extractImportedFiles(aggregated: AggregatedContext): Set<string> {
    const imports = new Set<string>();
    
    for (const pattern of aggregated.patterns) {
      if (pattern.type === 'import' && pattern.metadata?.source) {
        // Convert import path to file path
        const filePath = this.resolveImportPath(pattern.metadata.source);
        if (filePath) {
          imports.add(filePath);
        }
      }
    }
    
    return imports;
  }

  private resolveImportPath(importPath: string): string | undefined {
    // Simplified import resolution
    if (importPath.startsWith('.')) {
      return importPath + '.ts'; // Assume TypeScript
    }
    return undefined;
  }

  private isRelatedTestFile(testContext: Context, aggregated: AggregatedContext): boolean {
    const testFile = testContext.metadata?.file;
    if (!testFile) return false;
    
    // Check if any implementation file matches
    return aggregated.contexts.some(c => {
      const implFile = c.metadata?.file;
      if (!implFile || implFile.includes('.test.')) return false;
      
      const baseName = path.basename(implFile, path.extname(implFile));
      return testFile.includes(baseName);
    });
  }

  private isRelatedDocumentation(docContext: Context, aggregated: AggregatedContext): boolean {
    // Check if documentation mentions any of the included files
    const docContent = docContext.content.toLowerCase();
    
    return aggregated.contexts.some(c => {
      if (c.type !== 'code') return false;
      const fileName = c.metadata?.file;
      return fileName && docContent.includes(path.basename(fileName));
    });
  }

  private areTypesCompatible(type1: string, type2: string): boolean {
    const compatibilityMap: Record<string, string[]> = {
      'code': ['documentation', 'github'],
      'documentation': ['code', 'github'],
      'github': ['code', 'documentation']
    };
    
    return compatibilityMap[type1]?.includes(type2) || false;
  }

  private wasRecentlyUsedTogether(context1: Context, context2: Context): boolean {
    // Check if contexts were used in close proximity
    const index1 = this.recentContexts.findIndex(c => 
      this.isSameContext(c, context1)
    );
    const index2 = this.recentContexts.findIndex(c => 
      this.isSameContext(c, context2)
    );
    
    if (index1 === -1 || index2 === -1) return false;
    
    return Math.abs(index1 - index2) <= 2;
  }

  private areRelated(context1: Context, context2: Context): boolean {
    return this.detectRelationship(context1, context2) !== undefined ||
           this.scorer.calculateSimilarity(context1, context2) > 0.7;
  }

  private isSameContext(context1: Context, context2: Context): boolean {
    return this.getContextKey(context1) === this.getContextKey(context2);
  }

  private getContextKey(context: Context): string {
    return `${context.type}:${context.id || context.metadata?.file || context.content.slice(0, 50)}`;
  }

  private generateReason(current: Context, candidate: Context, score: number): string {
    const reasons: string[] = [];
    
    const relationship = this.detectRelationship(current, candidate);
    if (relationship) {
      reasons.push(relationship.replace('_', ' '));
    }
    
    if (score > 0.7) {
      reasons.push('highly similar');
    } else if (score > 0.5) {
      reasons.push('moderately related');
    }
    
    if (current.type !== candidate.type) {
      reasons.push(`complementary ${candidate.type}`);
    }
    
    return reasons.join(', ') || 'related content';
  }
}

// Re-export path for the import
import * as path from 'node:path';