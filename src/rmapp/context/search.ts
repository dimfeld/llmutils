import { Context, ContextType, ContextFilter } from './types.js';
import { ContextScorer } from './scorer.js';
import Fuse from 'fuse.js';

interface SearchResult {
  context: Context;
  score: number;
  matches?: Array<{
    field: string;
    value: string;
    indices: Array<[number, number]>;
  }>;
}

interface SearchOptions {
  limit?: number;
  threshold?: number;
  fuzzy?: boolean;
  expandQuery?: boolean;
  searchFields?: string[];
  boostFields?: Record<string, number>;
  filters?: CustomFilter;
}

interface CustomFilter {
  types?: ContextType[];
  dateRange?: {
    start?: Date;
    end?: Date;
  };
  metadata?: Record<string, any>;
  custom?: (context: Context) => boolean;
}

interface QueryExpansion {
  original: string;
  expanded: string[];
  synonyms: string[];
  related: string[];
}

export class ContextSearch {
  private scorer: ContextScorer;
  private synonymMap: Map<string, string[]>;
  private relatedTerms: Map<string, string[]>;
  private fuse?: Fuse<Context>;

  constructor(scorer: ContextScorer) {
    this.scorer = scorer;
    this.synonymMap = this.buildSynonymMap();
    this.relatedTerms = this.buildRelatedTermsMap();
  }

  // Main search method
  async search(
    query: string,
    contexts: Context[],
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    // Apply filters first
    let searchableContexts = this.applyFilters(contexts, options.filters);
    
    // Expand query if requested
    const expansion = options.expandQuery 
      ? this.expandQuery(query)
      : { original: query, expanded: [query], synonyms: [], related: [] };
    
    // Perform search
    let results: SearchResult[];
    
    if (options.fuzzy) {
      results = await this.fuzzySearch(
        expansion,
        searchableContexts,
        options
      );
    } else {
      results = await this.exactSearch(
        expansion,
        searchableContexts,
        options
      );
    }
    
    // Apply threshold filter
    if (options.threshold !== undefined) {
      results = results.filter(r => r.score >= options.threshold!);
    }
    
    // Sort by score and limit
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit || 50);
  }

  // Search with multiple queries (OR operation)
  async searchMultiple(
    queries: string[],
    contexts: Context[],
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    const allResults = new Map<string, SearchResult>();
    
    for (const query of queries) {
      const results = await this.search(query, contexts, options);
      
      // Merge results, keeping highest score
      for (const result of results) {
        const key = this.getContextKey(result.context);
        const existing = allResults.get(key);
        
        if (!existing || result.score > existing.score) {
          allResults.set(key, result);
        }
      }
    }
    
    return Array.from(allResults.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit || 50);
  }

  // Advanced search with field-specific queries
  async advancedSearch(
    fieldQueries: Record<string, string>,
    contexts: Context[],
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    let results = contexts;
    
    // Apply each field query as a filter
    for (const [field, query] of Object.entries(fieldQueries)) {
      results = results.filter(context => {
        const value = this.getFieldValue(context, field);
        if (!value) return false;
        
        return value.toLowerCase().includes(query.toLowerCase());
      });
    }
    
    // Score the filtered results
    const scoredResults: SearchResult[] = [];
    for (const context of results) {
      const score = await this.scoreAdvancedMatch(
        context,
        fieldQueries,
        options
      );
      
      scoredResults.push({ context, score });
    }
    
    return scoredResults
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit || 50);
  }

  // Suggest query completions
  suggestCompletions(
    partial: string,
    contexts: Context[],
    limit: number = 10
  ): string[] {
    const suggestions = new Set<string>();
    const lowerPartial = partial.toLowerCase();
    
    // Extract terms from contexts
    for (const context of contexts) {
      const terms = this.extractSearchableTerms(context);
      
      for (const term of terms) {
        if (term.toLowerCase().startsWith(lowerPartial)) {
          suggestions.add(term);
        }
      }
    }
    
    // Add synonym suggestions
    for (const [term, synonyms] of this.synonymMap.entries()) {
      if (term.startsWith(lowerPartial)) {
        suggestions.add(term);
      }
      for (const syn of synonyms) {
        if (syn.startsWith(lowerPartial)) {
          suggestions.add(syn);
        }
      }
    }
    
    return Array.from(suggestions)
      .sort((a, b) => {
        // Prefer exact prefix matches
        const aExact = a.toLowerCase() === lowerPartial;
        const bExact = b.toLowerCase() === lowerPartial;
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;
        
        // Then sort by length (shorter first)
        return a.length - b.length;
      })
      .slice(0, limit);
  }

  // Query expansion
  private expandQuery(query: string): QueryExpansion {
    const words = query.toLowerCase().split(/\s+/);
    const expandedWords = new Set<string>(words);
    const synonyms: string[] = [];
    const related: string[] = [];
    
    // Add synonyms
    for (const word of words) {
      const wordSynonyms = this.synonymMap.get(word) || [];
      for (const syn of wordSynonyms) {
        expandedWords.add(syn);
        synonyms.push(syn);
      }
    }
    
    // Add related terms
    for (const word of words) {
      const relatedWords = this.relatedTerms.get(word) || [];
      for (const rel of relatedWords) {
        expandedWords.add(rel);
        related.push(rel);
      }
    }
    
    // Generate expanded queries
    const expanded: string[] = [query];
    
    // Add synonym variations
    if (synonyms.length > 0) {
      expanded.push(
        words.map(w => 
          this.synonymMap.get(w)?.[0] || w
        ).join(' ')
      );
    }
    
    return {
      original: query,
      expanded,
      synonyms: Array.from(new Set(synonyms)),
      related: Array.from(new Set(related))
    };
  }

  // Fuzzy search implementation
  private async fuzzySearch(
    expansion: QueryExpansion,
    contexts: Context[],
    options: SearchOptions
  ): Promise<SearchResult[]> {
    // Initialize Fuse if needed
    if (!this.fuse) {
      this.fuse = new Fuse(contexts, {
        keys: this.getFuseKeys(options),
        threshold: 0.3,
        includeScore: true,
        includeMatches: true,
        minMatchCharLength: 2,
        useExtendedSearch: true
      });
    }
    
    const results: SearchResult[] = [];
    
    // Search with each expanded query
    for (const query of expansion.expanded) {
      const fuseResults = this.fuse.search(query);
      
      for (const result of fuseResults) {
        results.push({
          context: result.item,
          score: 1 - (result.score || 0),
          matches: result.matches?.map(m => ({
            field: m.key || '',
            value: m.value || '',
            indices: (m.indices || []) as Array<[number, number]>
          }))
        });
      }
    }
    
    // Deduplicate and combine scores
    return this.deduplicateResults(results);
  }

  // Exact search implementation
  private async exactSearch(
    expansion: QueryExpansion,
    contexts: Context[],
    options: SearchOptions
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    
    for (const context of contexts) {
      let totalScore = 0;
      let matchCount = 0;
      const matches: SearchResult['matches'] = [];
      
      // Search in each field
      const searchFields = options.searchFields || [
        'content',
        'metadata.file',
        'metadata.title',
        'metadata.description'
      ];
      
      for (const field of searchFields) {
        const value = this.getFieldValue(context, field);
        if (!value) continue;
        
        const fieldScore = this.scoreFieldMatch(
          value,
          expansion,
          field,
          options
        );
        
        if (fieldScore > 0) {
          totalScore += fieldScore;
          matchCount++;
          
          // Record match details
          const matchIndices = this.findMatchIndices(value, expansion);
          if (matchIndices.length > 0) {
            matches.push({
              field,
              value: value.slice(0, 100),
              indices: matchIndices
            });
          }
        }
      }
      
      if (matchCount > 0) {
        results.push({
          context,
          score: totalScore / searchFields.length,
          matches
        });
      }
    }
    
    return results;
  }

  // Score field match
  private scoreFieldMatch(
    value: string,
    expansion: QueryExpansion,
    field: string,
    options: SearchOptions
  ): number {
    const lowerValue = value.toLowerCase();
    let score = 0;
    
    // Check original query
    if (lowerValue.includes(expansion.original.toLowerCase())) {
      score = 1.0;
    }
    // Check expanded queries
    else if (expansion.expanded.some(q => lowerValue.includes(q.toLowerCase()))) {
      score = 0.8;
    }
    // Check synonyms
    else if (expansion.synonyms.some(s => lowerValue.includes(s.toLowerCase()))) {
      score = 0.6;
    }
    // Check related terms
    else if (expansion.related.some(r => lowerValue.includes(r.toLowerCase()))) {
      score = 0.4;
    }
    
    // Apply field boost
    if (options.boostFields && options.boostFields[field]) {
      score *= options.boostFields[field];
    }
    
    return score;
  }

  // Apply filters
  private applyFilters(
    contexts: Context[],
    filters?: CustomFilter
  ): Context[] {
    if (!filters) return contexts;
    
    return contexts.filter(context => {
      // Type filter
      if (filters.types && !filters.types.includes(context.type)) {
        return false;
      }
      
      // Date range filter
      if (filters.dateRange) {
        const contextDate = new Date(context.timestamp);
        if (filters.dateRange.start && contextDate < filters.dateRange.start) {
          return false;
        }
        if (filters.dateRange.end && contextDate > filters.dateRange.end) {
          return false;
        }
      }
      
      // Metadata filters
      if (filters.metadata) {
        for (const [key, value] of Object.entries(filters.metadata)) {
          if (context.metadata?.[key] !== value) {
            return false;
          }
        }
      }
      
      // Custom filter function
      if (filters.custom) {
        return filters.custom(context);
      }
      
      return true;
    });
  }

  // Helper methods
  private getFuseKeys(options: SearchOptions): Array<{
    name: string;
    weight: number;
  }> {
    const defaultKeys = [
      { name: 'content', weight: 1.0 },
      { name: 'metadata.file', weight: 0.8 },
      { name: 'metadata.title', weight: 0.7 },
      { name: 'metadata.description', weight: 0.6 }
    ];
    
    if (options.searchFields) {
      return options.searchFields.map(field => ({
        name: field,
        weight: options.boostFields?.[field] || 1.0
      }));
    }
    
    return defaultKeys;
  }

  private getFieldValue(context: Context, field: string): string | undefined {
    const parts = field.split('.');
    let value: any = context;
    
    for (const part of parts) {
      value = value?.[part];
      if (value === undefined) return undefined;
    }
    
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  private findMatchIndices(
    text: string,
    expansion: QueryExpansion
  ): Array<[number, number]> {
    const indices: Array<[number, number]> = [];
    const lowerText = text.toLowerCase();
    
    const searchTerms = [
      expansion.original,
      ...expansion.expanded,
      ...expansion.synonyms,
      ...expansion.related
    ];
    
    for (const term of searchTerms) {
      const lowerTerm = term.toLowerCase();
      let index = lowerText.indexOf(lowerTerm);
      
      while (index !== -1) {
        indices.push([index, index + term.length - 1]);
        index = lowerText.indexOf(lowerTerm, index + 1);
      }
    }
    
    // Sort and merge overlapping indices
    return this.mergeIndices(indices);
  }

  private mergeIndices(
    indices: Array<[number, number]>
  ): Array<[number, number]> {
    if (indices.length === 0) return [];
    
    // Sort by start index
    indices.sort((a, b) => a[0] - b[0]);
    
    const merged: Array<[number, number]> = [indices[0]];
    
    for (let i = 1; i < indices.length; i++) {
      const last = merged[merged.length - 1];
      const current = indices[i];
      
      // If overlapping or adjacent, merge
      if (current[0] <= last[1] + 1) {
        last[1] = Math.max(last[1], current[1]);
      } else {
        merged.push(current);
      }
    }
    
    return merged;
  }

  private deduplicateResults(results: SearchResult[]): SearchResult[] {
    const uniqueResults = new Map<string, SearchResult>();
    
    for (const result of results) {
      const key = this.getContextKey(result.context);
      const existing = uniqueResults.get(key);
      
      if (!existing || result.score > existing.score) {
        uniqueResults.set(key, result);
      } else if (existing && result.matches) {
        // Merge matches
        existing.matches = [
          ...(existing.matches || []),
          ...result.matches
        ];
      }
    }
    
    return Array.from(uniqueResults.values());
  }

  private extractSearchableTerms(context: Context): string[] {
    const terms = new Set<string>();
    
    // Extract from content
    const words = context.content.match(/\b\w{3,}\b/g) || [];
    for (const word of words) {
      terms.add(word);
    }
    
    // Extract from metadata
    if (context.metadata) {
      const metadataStr = JSON.stringify(context.metadata);
      const metaWords = metadataStr.match(/\b\w{3,}\b/g) || [];
      for (const word of metaWords) {
        terms.add(word);
      }
    }
    
    return Array.from(terms);
  }

  private async scoreAdvancedMatch(
    context: Context,
    fieldQueries: Record<string, string>,
    options: SearchOptions
  ): Promise<number> {
    let totalScore = 0;
    let fieldCount = 0;
    
    for (const [field, query] of Object.entries(fieldQueries)) {
      const value = this.getFieldValue(context, field);
      if (!value) continue;
      
      const expansion = options.expandQuery 
        ? this.expandQuery(query)
        : { original: query, expanded: [query], synonyms: [], related: [] };
      
      const fieldScore = this.scoreFieldMatch(
        value,
        expansion,
        field,
        options
      );
      
      totalScore += fieldScore;
      fieldCount++;
    }
    
    return fieldCount > 0 ? totalScore / fieldCount : 0;
  }

  private getContextKey(context: Context): string {
    return `${context.type}:${context.id || context.metadata?.file || context.content.slice(0, 50)}`;
  }

  // Build synonym map for common programming terms
  private buildSynonymMap(): Map<string, string[]> {
    return new Map([
      ['function', ['method', 'fn', 'func', 'procedure']],
      ['class', ['type', 'interface', 'struct']],
      ['error', ['exception', 'err', 'fault', 'bug']],
      ['test', ['spec', 'tests', 'testing', 'unit test']],
      ['import', ['require', 'include', 'use']],
      ['export', ['module.exports', 'exports']],
      ['async', ['asynchronous', 'promise', 'await']],
      ['config', ['configuration', 'settings', 'options']],
      ['init', ['initialize', 'setup', 'bootstrap']],
      ['update', ['modify', 'change', 'edit', 'patch']],
      ['delete', ['remove', 'destroy', 'rm']],
      ['create', ['add', 'new', 'make', 'generate']],
      ['get', ['fetch', 'retrieve', 'find', 'read']],
      ['set', ['update', 'assign', 'write']],
      ['response', ['reply', 'answer', 'res']],
      ['request', ['req', 'query']],
      ['handler', ['controller', 'processor']],
      ['middleware', ['interceptor', 'filter']],
      ['auth', ['authentication', 'authorization', 'login']],
      ['user', ['account', 'member', 'client']],
      ['api', ['endpoint', 'route', 'service']],
      ['db', ['database', 'store', 'repository']],
      ['cache', ['buffer', 'memory', 'store']],
      ['log', ['logger', 'logging', 'console']],
      ['debug', ['trace', 'inspect', 'troubleshoot']],
      ['build', ['compile', 'bundle', 'package']],
      ['deploy', ['release', 'publish', 'ship']],
      ['fix', ['repair', 'patch', 'resolve']],
      ['pr', ['pull request', 'merge request']],
      ['commit', ['check in', 'save', 'push']]
    ]);
  }

  // Build related terms map
  private buildRelatedTermsMap(): Map<string, string[]> {
    return new Map([
      ['react', ['component', 'jsx', 'hooks', 'state']],
      ['vue', ['component', 'template', 'computed', 'reactive']],
      ['angular', ['component', 'service', 'module', 'directive']],
      ['node', ['npm', 'express', 'module', 'require']],
      ['typescript', ['type', 'interface', 'generic', 'enum']],
      ['javascript', ['js', 'ecmascript', 'es6', 'node']],
      ['python', ['pip', 'django', 'flask', 'pytest']],
      ['test', ['jest', 'mocha', 'assert', 'expect']],
      ['git', ['branch', 'commit', 'merge', 'rebase']],
      ['docker', ['container', 'image', 'compose', 'kubernetes']],
      ['api', ['rest', 'graphql', 'endpoint', 'http']],
      ['database', ['sql', 'nosql', 'query', 'schema']],
      ['security', ['auth', 'encryption', 'csrf', 'xss']],
      ['performance', ['optimization', 'speed', 'memory', 'cache']],
      ['error', ['stack trace', 'debug', 'exception', 'catch']],
      ['async', ['callback', 'promise', 'await', 'concurrent']],
      ['component', ['props', 'state', 'render', 'lifecycle']],
      ['style', ['css', 'scss', 'styled-components', 'theme']],
      ['build', ['webpack', 'rollup', 'babel', 'transpile']],
      ['deploy', ['ci/cd', 'pipeline', 'production', 'staging']]
    ]);
  }
}