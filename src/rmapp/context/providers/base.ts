import { createHash } from 'crypto';
import type { 
  Context, 
  ContextType, 
  ContextSource, 
  ContextMetadata, 
  ContextQuery 
} from '../types.js';

export interface ProviderConfig {
  cacheEnabled?: boolean;
  maxResults?: number;
  timeout?: number;
}

export abstract class ContextProvider {
  abstract type: ContextType;
  abstract priority: number;
  
  constructor(protected config: ProviderConfig = {}) {}
  
  abstract gather(query: ContextQuery): Promise<Context[]>;
  abstract validate(context: Context): Promise<boolean>;
  abstract refresh(context: Context): Promise<Context>;
  
  protected createContext(
    content: any,
    source: ContextSource,
    metadata: ContextMetadata
  ): Context {
    return {
      id: this.generateId(source, content),
      type: this.type,
      source,
      content,
      metadata,
      relevance: 0, // Will be scored later
      timestamp: new Date()
    };
  }
  
  protected generateId(source: ContextSource, content: any): string {
    const hash = createHash('sha256');
    hash.update(source.type);
    hash.update(source.location);
    hash.update(JSON.stringify(content).substring(0, 1000)); // First 1000 chars
    return hash.digest('hex').substring(0, 16);
  }
  
  protected matchesKeywords(text: string, keywords: string[]): boolean {
    const lowerText = text.toLowerCase();
    return keywords.some(keyword => 
      lowerText.includes(keyword.toLowerCase())
    );
  }
  
  protected extractSnippet(content: string, keywords: string[], maxLength: number = 500): string {
    // Find first keyword occurrence
    let bestIndex = -1;
    let bestKeyword = '';
    
    for (const keyword of keywords) {
      const index = content.toLowerCase().indexOf(keyword.toLowerCase());
      if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
        bestIndex = index;
        bestKeyword = keyword;
      }
    }
    
    if (bestIndex === -1) {
      // No keyword found, return beginning
      return content.substring(0, maxLength);
    }
    
    // Extract snippet around keyword
    const start = Math.max(0, bestIndex - Math.floor(maxLength / 2));
    const end = Math.min(content.length, start + maxLength);
    
    let snippet = content.substring(start, end);
    
    // Add ellipsis if truncated
    if (start > 0) snippet = '...' + snippet;
    if (end < content.length) snippet = snippet + '...';
    
    return snippet;
  }
  
  protected async batchProcess<T, R>(
    items: T[],
    processor: (item: T) => Promise<R>,
    batchSize: number = 10
  ): Promise<R[]> {
    const results: R[] = [];
    
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(item => processor(item))
      );
      results.push(...batchResults);
    }
    
    return results;
  }
}