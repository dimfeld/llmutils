import type { IssueAnalysis, EnrichedAnalysis } from './types.js';
import type { StateStore } from '../state/store.js';
import { log } from '../../logging.js';

export class AnalysisCache {
  private memoryCache = new Map<string, CachedAnalysis>();
  private readonly cacheExpiry = 60 * 60 * 1000; // 1 hour

  constructor(private store: StateStore) {}

  async get(issueId: number): Promise<EnrichedAnalysis | null> {
    const cacheKey = this.getCacheKey(issueId);
    
    // Check memory cache first
    const cached = this.memoryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      log(`Analysis cache hit for issue #${issueId}`);
      return cached.analysis;
    }
    
    // Check database cache
    try {
      const workflow = await this.store.getWorkflowByIssue(issueId);
      if (workflow && workflow.type === 'issue' && workflow.analysis) {
        const analysis = JSON.parse(workflow.analysis) as EnrichedAnalysis;
        
        // Update memory cache
        this.memoryCache.set(cacheKey, {
          analysis,
          timestamp: new Date(workflow.updatedAt).getTime(),
        });
        
        // Check if still valid
        if (Date.now() - new Date(workflow.updatedAt).getTime() < this.cacheExpiry) {
          log(`Analysis database cache hit for issue #${issueId}`);
          return analysis;
        }
      }
    } catch (error) {
      log('Error retrieving cached analysis:', error);
    }
    
    return null;
  }

  async set(issueId: number, analysis: EnrichedAnalysis): Promise<void> {
    const cacheKey = this.getCacheKey(issueId);
    
    // Update memory cache
    this.memoryCache.set(cacheKey, {
      analysis,
      timestamp: Date.now(),
    });
    
    // Update database cache
    try {
      const workflow = await this.store.getWorkflowByIssue(issueId);
      if (workflow) {
        await this.store.updateWorkflowMetadata(workflow.id, {
          analysis: JSON.stringify(analysis),
        });
      }
    } catch (error) {
      log('Error caching analysis:', error);
    }
  }

  async invalidate(issueId: number): Promise<void> {
    const cacheKey = this.getCacheKey(issueId);
    
    // Remove from memory cache
    this.memoryCache.delete(cacheKey);
    
    // Clear from database
    try {
      const workflow = await this.store.getWorkflowByIssue(issueId);
      if (workflow) {
        await this.store.updateWorkflowMetadata(workflow.id, {
          analysis: null,
        });
      }
    } catch (error) {
      log('Error invalidating cached analysis:', error);
    }
  }

  clearMemoryCache(): void {
    this.memoryCache.clear();
  }

  private getCacheKey(issueId: number): string {
    return `issue-analysis-${issueId}`;
  }
}

interface CachedAnalysis {
  analysis: EnrichedAnalysis;
  timestamp: number;
}