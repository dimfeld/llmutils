import { Context, AggregatedContext, ContextType } from './types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
  key: string;
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

export class ContextCache {
  private memoryCache: Map<string, CacheEntry<Context | AggregatedContext>>;
  private accessOrder: string[];
  private maxSize: number;
  private defaultTTL: number;
  private persistPath?: string;
  private stats: CacheStats;
  private saveTimer?: NodeJS.Timeout;

  constructor(options: {
    maxSize?: number;
    defaultTTL?: number;
    persistPath?: string;
  } = {}) {
    this.memoryCache = new Map();
    this.accessOrder = [];
    this.maxSize = options.maxSize || 1000;
    this.defaultTTL = options.defaultTTL || 3600000; // 1 hour
    this.persistPath = options.persistPath;
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      size: 0
    };
  }

  async initialize(): Promise<void> {
    if (this.persistPath) {
      await this.loadFromDisk();
    }
  }

  async get(key: string): Promise<Context | AggregatedContext | undefined> {
    const entry = this.memoryCache.get(key);
    
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check TTL
    if (Date.now() > entry.timestamp + entry.ttl) {
      this.memoryCache.delete(key);
      this.removeFromAccessOrder(key);
      this.stats.misses++;
      return undefined;
    }

    // Update access order
    this.updateAccessOrder(key);
    this.stats.hits++;
    
    return entry.data;
  }

  async set(
    key: string,
    value: Context | AggregatedContext,
    ttl?: number
  ): Promise<void> {
    // Evict if necessary
    if (this.memoryCache.size >= this.maxSize && !this.memoryCache.has(key)) {
      await this.evictLRU();
    }

    const entry: CacheEntry<Context | AggregatedContext> = {
      data: value,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL,
      key
    };

    this.memoryCache.set(key, entry);
    this.updateAccessOrder(key);
    this.stats.size = this.memoryCache.size;

    // Schedule persistent save
    if (this.persistPath) {
      this.scheduleSave();
    }
  }

  async delete(key: string): Promise<boolean> {
    const deleted = this.memoryCache.delete(key);
    if (deleted) {
      this.removeFromAccessOrder(key);
      this.stats.size = this.memoryCache.size;
    }
    return deleted;
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    this.accessOrder = [];
    this.stats.size = 0;
    
    if (this.persistPath) {
      await this.saveToDisk();
    }
  }

  // Generate cache key for contexts
  generateKey(params: {
    type?: string;
    repo?: string;
    pr?: number;
    issue?: number;
    file?: string;
    query?: string;
    filters?: Record<string, any>;
  }): string {
    const normalized = JSON.stringify(params, Object.keys(params).sort());
    return createHash('sha256').update(normalized).digest('hex');
  }

  // Get cache statistics
  getStats(): CacheStats {
    return { ...this.stats };
  }

  // Invalidate entries matching pattern
  async invalidate(pattern: {
    type?: string;
    repo?: string;
    pr?: number;
    issue?: number;
    file?: string;
  }): Promise<number> {
    let invalidated = 0;
    
    for (const [key, entry] of this.memoryCache.entries()) {
      const context = entry.data;
      
      // Check if context matches pattern
      if (this.matchesPattern(context, pattern)) {
        this.memoryCache.delete(key);
        this.removeFromAccessOrder(key);
        invalidated++;
      }
    }

    this.stats.size = this.memoryCache.size;
    return invalidated;
  }

  // Batch operations
  async getBatch(keys: string[]): Promise<Map<string, Context | AggregatedContext>> {
    const results = new Map<string, Context | AggregatedContext>();
    
    for (const key of keys) {
      const value = await this.get(key);
      if (value) {
        results.set(key, value);
      }
    }
    
    return results;
  }

  async setBatch(entries: Array<{
    key: string;
    value: Context | AggregatedContext;
    ttl?: number;
  }>): Promise<void> {
    for (const entry of entries) {
      await this.set(entry.key, entry.value, entry.ttl);
    }
  }

  // Private methods
  private updateAccessOrder(key: string): void {
    // Remove from current position
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    
    // Add to end (most recently used)
    this.accessOrder.push(key);
  }

  private removeFromAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  private async evictLRU(): Promise<void> {
    if (this.accessOrder.length === 0) return;
    
    // Remove least recently used
    const lruKey = this.accessOrder.shift()!;
    this.memoryCache.delete(lruKey);
    this.stats.evictions++;
    this.stats.size = this.memoryCache.size;
  }

  private matchesPattern(
    context: Context | AggregatedContext,
    pattern: any
  ): boolean {
    // For aggregated contexts, check all contained contexts
    if ('byType' in context) {
      // Check all contexts in the aggregated context
      for (const contexts of context.byType.values()) {
        if (contexts.some((c: Context) => this.matchesPattern(c, pattern))) {
          return true;
        }
      }
      return false;
    }

    // Check individual context
    if (pattern.type && context.type !== pattern.type) return false;
    
    if (pattern.repo) {
      const contextRepo = this.extractRepo(context);
      if (contextRepo !== pattern.repo) return false;
    }

    if (pattern.file && context.type === ContextType.Code) {
      if (!context.metadata?.file?.includes(pattern.file)) return false;
    }

    if (pattern.pr && context.type === ContextType.PullRequest) {
      if (context.metadata?.pr !== pattern.pr) return false;
    }

    if (pattern.issue && context.type === ContextType.Issue) {
      if (context.metadata?.issue !== pattern.issue) return false;
    }

    return true;
  }

  private extractRepo(context: Context): string | undefined {
    if (context.metadata?.repo) return context.metadata.repo;
    if (context.metadata?.url) {
      const match = context.metadata.url.match(/github\.com\/([^\/]+\/[^\/]+)/);
      return match?.[1];
    }
    return undefined;
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    
    this.saveTimer = setTimeout(() => {
      this.saveToDisk().catch(console.error);
    }, 5000); // Save after 5 seconds of inactivity
  }

  private async saveToDisk(): Promise<void> {
    if (!this.persistPath) return;

    const data = {
      version: 1,
      entries: Array.from(this.memoryCache.entries()).map(([key, entry]) => ({
        key,
        entry
      })),
      accessOrder: this.accessOrder,
      stats: this.stats
    };

    await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
    await fs.writeFile(
      this.persistPath,
      JSON.stringify(data, null, 2),
      'utf-8'
    );
  }

  private async loadFromDisk(): Promise<void> {
    if (!this.persistPath) return;

    try {
      const content = await fs.readFile(this.persistPath, 'utf-8');
      const data = JSON.parse(content);

      if (data.version !== 1) {
        console.warn('Incompatible cache version, starting fresh');
        return;
      }

      // Load entries, filtering out expired ones
      const now = Date.now();
      for (const { key, entry } of data.entries) {
        if (now <= entry.timestamp + entry.ttl) {
          this.memoryCache.set(key, entry);
        }
      }

      // Rebuild access order for non-expired entries
      this.accessOrder = data.accessOrder.filter((key: string) => 
        this.memoryCache.has(key)
      );

      this.stats = data.stats;
      this.stats.size = this.memoryCache.size;
    } catch (error) {
      // File doesn't exist or is corrupted, start fresh
      if ((error as any).code !== 'ENOENT') {
        console.warn('Failed to load cache from disk:', error);
      }
    }
  }

  // Cleanup method
  async cleanup(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    
    if (this.persistPath) {
      await this.saveToDisk();
    }
  }
}

// Specialized cache for different context types
export class TypedContextCache {
  private caches: Map<string, ContextCache>;
  
  constructor(private options: {
    maxSizePerType?: number;
    defaultTTL?: number;
    persistDir?: string;
  } = {}) {
    this.caches = new Map();
  }

  private getCache(type: string): ContextCache {
    if (!this.caches.has(type)) {
      const cache = new ContextCache({
        maxSize: this.options.maxSizePerType || 200,
        defaultTTL: this.options.defaultTTL,
        persistPath: this.options.persistDir 
          ? path.join(this.options.persistDir, `${type}.json`)
          : undefined
      });
      this.caches.set(type, cache);
    }
    return this.caches.get(type)!;
  }

  async get(type: string, key: string): Promise<Context | undefined> {
    const cache = this.getCache(type);
    return cache.get(key) as Promise<Context | undefined>;
  }

  async set(type: string, key: string, value: Context, ttl?: number): Promise<void> {
    const cache = this.getCache(type);
    return cache.set(key, value, ttl);
  }

  async invalidateAll(pattern: any): Promise<number> {
    let total = 0;
    for (const cache of this.caches.values()) {
      total += await cache.invalidate(pattern);
    }
    return total;
  }

  async getStats(): Promise<Map<string, CacheStats>> {
    const stats = new Map<string, CacheStats>();
    for (const [type, cache] of this.caches.entries()) {
      stats.set(type, cache.getStats());
    }
    return stats;
  }

  async cleanup(): Promise<void> {
    for (const cache of this.caches.values()) {
      await cache.cleanup();
    }
  }
}