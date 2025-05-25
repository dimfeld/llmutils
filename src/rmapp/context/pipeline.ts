import type { 
  Context, 
  AggregatedContext, 
  ContextFilter,
  ContextProvider as IContextProvider 
} from './types.js';
import { CodeContextProvider } from './code_provider.js';
import { DocumentationProvider } from './documentation_provider.js';
import { GitHubProvider } from './github_provider.js';
import { ContextScorer } from './scorer.js';
import { ContextAggregator } from './aggregator.js';
import { ContextCache, TypedContextCache } from './cache.js';
import { ContextRecommender } from './recommender.js';
import { ContextSearch } from './search.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface PipelineOptions {
  providers?: {
    code?: boolean;
    documentation?: boolean;
    github?: boolean;
    custom?: IContextProvider[];
  };
  cache?: {
    enabled?: boolean;
    maxSize?: number;
    ttl?: number;
    persistPath?: string;
  };
  search?: {
    fuzzy?: boolean;
    expandQuery?: boolean;
    threshold?: number;
  };
  recommendation?: {
    enabled?: boolean;
    maxRecommendations?: number;
    minScore?: number;
  };
  aggregation?: {
    maxRelationshipDepth?: number;
  };
}

interface GatherOptions {
  query?: string;
  files?: string[];
  types?: string[];
  filters?: ContextFilter;
  includeRecommendations?: boolean;
  maxContexts?: number;
  aggregate?: boolean;
}

interface PipelineResult {
  contexts: Context[];
  aggregated?: AggregatedContext;
  recommendations?: Array<{
    context: Context;
    reason: string;
    score: number;
  }>;
  stats: {
    totalContexts: number;
    byType: Record<string, number>;
    cacheHits: number;
    cacheMisses: number;
    searchTime: number;
    aggregationTime: number;
  };
}

export class ContextPipeline {
  private providers: Map<string, IContextProvider>;
  private scorer: ContextScorer;
  private aggregator: ContextAggregator;
  private cache?: ContextCache;
  private typedCache?: TypedContextCache;
  private recommender: ContextRecommender;
  private search: ContextSearch;
  private options: PipelineOptions;

  constructor(options: PipelineOptions = {}) {
    this.options = options;
    this.providers = new Map();
    this.scorer = new ContextScorer();
    this.aggregator = new ContextAggregator(this.scorer, {
      maxRelationshipDepth: options.aggregation?.maxRelationshipDepth
    });
    this.recommender = new ContextRecommender(this.scorer);
    this.search = new ContextSearch(this.scorer);
    
    // Initialize providers
    this.initializeProviders();
    
    // Initialize cache if enabled
    if (options.cache?.enabled !== false) {
      this.initializeCache();
    }
  }

  async initialize(): Promise<void> {
    // Initialize all providers
    for (const provider of this.providers.values()) {
      await provider.initialize();
    }
    
    // Initialize cache
    if (this.cache) {
      await this.cache.initialize();
    }
  }

  // Main gather method
  async gather(options: GatherOptions): Promise<PipelineResult> {
    const startTime = Date.now();
    const stats = {
      totalContexts: 0,
      byType: {} as Record<string, number>,
      cacheHits: 0,
      cacheMisses: 0,
      searchTime: 0,
      aggregationTime: 0
    };

    try {
      // Phase 1: Collect contexts
      let contexts = await this.collectContexts(options, stats);
      
      // Phase 2: Search/filter if query provided
      if (options.query) {
        const searchStart = Date.now();
        contexts = await this.searchContexts(
          options.query,
          contexts,
          options
        );
        stats.searchTime = Date.now() - searchStart;
      }
      
      // Phase 3: Apply limits
      if (options.maxContexts) {
        contexts = contexts.slice(0, options.maxContexts);
      }
      
      // Phase 4: Get recommendations
      let recommendations;
      if (options.includeRecommendations && contexts.length > 0) {
        recommendations = await this.getRecommendations(
          contexts,
          options
        );
      }
      
      // Phase 5: Aggregate if requested
      let aggregated;
      if (options.aggregate && contexts.length > 0) {
        const aggStart = Date.now();
        aggregated = this.aggregator.aggregate(contexts);
        stats.aggregationTime = Date.now() - aggStart;
        
        // Cache aggregated result
        if (this.cache && options.query) {
          const cacheKey = this.cache.generateKey({
            query: options.query,
            filters: options.filters,
            aggregate: true
          });
          await this.cache.set(cacheKey, aggregated);
        }
      }
      
      // Update stats
      stats.totalContexts = contexts.length;
      for (const context of contexts) {
        stats.byType[context.type] = (stats.byType[context.type] || 0) + 1;
      }
      
      return {
        contexts,
        aggregated,
        recommendations,
        stats
      };
    } catch (error) {
      console.error('Context pipeline error:', error);
      throw error;
    }
  }

  // Gather from specific files
  async gatherFromFiles(
    files: string[],
    options: Omit<GatherOptions, 'files'> = {}
  ): Promise<PipelineResult> {
    return this.gather({ ...options, files });
  }

  // Gather for a specific GitHub PR
  async gatherForPR(
    repo: string,
    prNumber: number,
    options: Omit<GatherOptions, 'filters'> = {}
  ): Promise<PipelineResult> {
    const filters: ContextFilter = {
      field: 'metadata.pr',
      operator: 'eq',
      value: prNumber
    };
    
    return this.gather({ ...options, filters, types: ['github', 'code'] });
  }

  // Gather for a specific GitHub issue
  async gatherForIssue(
    repo: string,
    issueNumber: number,
    options: Omit<GatherOptions, 'filters'> = {}
  ): Promise<PipelineResult> {
    const filters: ContextFilter = {
      field: 'metadata.issue',
      operator: 'eq',
      value: issueNumber
    };
    
    return this.gather({ ...options, filters, types: ['github', 'code'] });
  }

  // Search across all available contexts
  async searchAll(
    query: string,
    options: {
      limit?: number;
      types?: string[];
      fuzzy?: boolean;
    } = {}
  ): Promise<Context[]> {
    // Get all available contexts
    const allContexts = await this.getAllAvailableContexts(options.types);
    
    // Perform search
    const results = await this.search.search(query, allContexts, {
      limit: options.limit,
      fuzzy: options.fuzzy ?? this.options.search?.fuzzy,
      expandQuery: this.options.search?.expandQuery,
      threshold: this.options.search?.threshold
    });
    
    return results.map(r => r.context);
  }

  // Get suggested queries
  async getSuggestions(
    partial: string,
    limit: number = 10
  ): Promise<string[]> {
    const allContexts = await this.getAllAvailableContexts();
    return this.search.suggestCompletions(partial, allContexts, limit);
  }

  // Invalidate cache entries
  async invalidateCache(pattern: {
    type?: string;
    repo?: string;
    pr?: number;
    issue?: number;
    file?: string;
  }): Promise<number> {
    let invalidated = 0;
    
    if (this.cache) {
      invalidated += await this.cache.invalidate(pattern);
    }
    
    if (this.typedCache) {
      invalidated += await this.typedCache.invalidateAll(pattern);
    }
    
    return invalidated;
  }

  // Get pipeline statistics
  async getStats(): Promise<{
    providers: Record<string, { available: boolean }>;
    cache?: {
      main: any;
      typed?: Map<string, any>;
    };
  }> {
    const stats: any = {
      providers: {}
    };
    
    // Provider stats
    for (const [name, provider] of this.providers.entries()) {
      stats.providers[name] = {
        available: await provider.isAvailable()
      };
    }
    
    // Cache stats
    if (this.cache) {
      stats.cache = {
        main: this.cache.getStats()
      };
      
      if (this.typedCache) {
        stats.cache.typed = await this.typedCache.getStats();
      }
    }
    
    return stats;
  }

  // Cleanup
  async cleanup(): Promise<void> {
    if (this.cache) {
      await this.cache.cleanup();
    }
    
    if (this.typedCache) {
      await this.typedCache.cleanup();
    }
  }

  // Private methods
  private initializeProviders(): void {
    const providerOptions = this.options.providers || {};
    
    // Built-in providers
    if (providerOptions.code !== false) {
      this.providers.set('code', new CodeContextProvider());
    }
    
    if (providerOptions.documentation !== false) {
      this.providers.set('documentation', new DocumentationProvider());
    }
    
    if (providerOptions.github !== false) {
      this.providers.set('github', new GitHubProvider());
    }
    
    // Custom providers
    if (providerOptions.custom) {
      for (const provider of providerOptions.custom) {
        this.providers.set(provider.type, provider);
      }
    }
  }

  private initializeCache(): void {
    const cacheOptions = this.options.cache || {};
    
    this.cache = new ContextCache({
      maxSize: cacheOptions.maxSize || 1000,
      defaultTTL: cacheOptions.ttl || 3600000,
      persistPath: cacheOptions.persistPath
    });
    
    if (cacheOptions.persistPath) {
      const cacheDir = path.dirname(cacheOptions.persistPath);
      this.typedCache = new TypedContextCache({
        maxSizePerType: 200,
        defaultTTL: cacheOptions.ttl,
        persistDir: path.join(cacheDir, 'typed')
      });
    }
  }

  private async collectContexts(
    options: GatherOptions,
    stats: PipelineResult['stats']
  ): Promise<Context[]> {
    const contexts: Context[] = [];
    
    // Determine which providers to use
    const typesToUse = options.types || Array.from(this.providers.keys());
    
    // Collect from each provider
    for (const type of typesToUse) {
      const provider = this.providers.get(type);
      if (!provider || !(await provider.isAvailable())) continue;
      
      try {
        // Check cache first
        let providerContexts: Context[] | undefined;
        
        if (this.typedCache && options.query) {
          const cacheKey = this.cache!.generateKey({
            type,
            query: options.query,
            filters: options.filters
          });
          
          const cached = await this.typedCache.get(type, cacheKey);
          if (cached) {
            providerContexts = [cached];
            stats.cacheHits++;
          }
        }
        
        // Fetch if not cached
        if (!providerContexts) {
          stats.cacheMisses++;
          
          if (options.files && type === 'code') {
            // Special handling for file-based collection
            providerContexts = await this.collectFromFiles(
              provider,
              options.files
            );
          } else {
            // General collection
            providerContexts = await provider.gather({
              query: options.query,
              filters: options.filters,
              limit: options.maxContexts
            });
          }
          
          // Cache results
          if (this.typedCache && options.query && providerContexts && providerContexts.length > 0) {
            const cacheKey = this.cache!.generateKey({
              type,
              query: options.query,
              filters: options.filters
            });
            
            for (const context of providerContexts || []) {
              await this.typedCache.set(type, cacheKey, context);
            }
          }
        }
        
        if (providerContexts) {
          contexts.push(...providerContexts);
        }
      } catch (error) {
        console.error(`Error collecting from ${type} provider:`, error);
      }
    }
    
    return contexts;
  }

  private async collectFromFiles(
    provider: IContextProvider,
    files: string[]
  ): Promise<Context[]> {
    const contexts: Context[] = [];
    
    for (const file of files) {
      try {
        const fileContexts = await provider.gather({
          filters: [{ field: 'metadata.file', operator: 'eq', value: file }]
        });
        contexts.push(...fileContexts);
      } catch (error) {
        console.error(`Error collecting context from ${file}:`, error);
      }
    }
    
    return contexts;
  }

  private async searchContexts(
    query: string,
    contexts: Context[],
    options: GatherOptions
  ): Promise<Context[]> {
    const searchOptions = {
      fuzzy: this.options.search?.fuzzy,
      expandQuery: this.options.search?.expandQuery,
      threshold: this.options.search?.threshold,
      filters: options.filters
    };
    
    const results = await this.search.search(query, contexts, searchOptions);
    return results.map(r => r.context);
  }

  private async getRecommendations(
    contexts: Context[],
    options: GatherOptions
  ): Promise<PipelineResult['recommendations']> {
    if (!this.options.recommendation?.enabled !== false) {
      return undefined;
    }
    
    // Get all available contexts for recommendations
    const allContexts = await this.getAllAvailableContexts();
    
    // Create aggregated context for better recommendations
    const aggregated = this.aggregator.aggregate(contexts);
    
    // Get recommendations
    const recs = await this.recommender.recommendFromAggregated(
      aggregated,
      allContexts,
      {
        maxRecommendations: this.options.recommendation?.maxRecommendations,
        minScore: this.options.recommendation?.minScore,
        excludeTypes: options.types ? 
          Array.from(this.providers.keys()).filter(t => !options.types!.includes(t)) :
          undefined
      }
    );
    
    // Also detect missing contexts
    const missing = this.recommender.detectMissingContexts(
      aggregated,
      allContexts
    );
    
    return [...recs, ...missing];
  }

  private async getAllAvailableContexts(
    types?: string[]
  ): Promise<Context[]> {
    const contexts: Context[] = [];
    const typesToUse = types || Array.from(this.providers.keys());
    
    for (const type of typesToUse) {
      const provider = this.providers.get(type);
      if (!provider || !(await provider.isAvailable())) continue;
      
      try {
        const providerContexts = await provider.list();
        contexts.push(...providerContexts);
      } catch (error) {
        console.error(`Error listing contexts from ${type}:`, error);
      }
    }
    
    return contexts;
  }
}

// Factory function for common configurations
export function createContextPipeline(preset: 'default' | 'github' | 'minimal'): ContextPipeline {
  const configs: Record<string, PipelineOptions> = {
    default: {
      providers: {
        code: true,
        documentation: true,
        github: true
      },
      cache: {
        enabled: true,
        maxSize: 1000,
        ttl: 3600000
      },
      search: {
        fuzzy: true,
        expandQuery: true,
        threshold: 0.3
      },
      recommendation: {
        enabled: true,
        maxRecommendations: 10,
        minScore: 0.4
      }
    },
    github: {
      providers: {
        code: true,
        documentation: false,
        github: true
      },
      cache: {
        enabled: true,
        maxSize: 500,
        ttl: 1800000 // 30 minutes
      },
      search: {
        fuzzy: true,
        expandQuery: false
      },
      recommendation: {
        enabled: true,
        maxRecommendations: 5
      }
    },
    minimal: {
      providers: {
        code: true,
        documentation: false,
        github: false
      },
      cache: {
        enabled: false
      },
      search: {
        fuzzy: false,
        expandQuery: false
      },
      recommendation: {
        enabled: false
      }
    }
  };
  
  return new ContextPipeline(configs[preset]);
}