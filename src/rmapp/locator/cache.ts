import { createHash } from 'crypto';
import type { CodeLocation, CacheContext, CachedLocation } from './types';

export class LocationCache {
  private cache = new Map<string, CachedLocation>();
  private maxAge = 3600000; // 1 hour
  private maxSize = 1000;

  async get(
    reference: string,
    context: CacheContext
  ): Promise<CodeLocation | null> {
    const key = this.generateKey(reference, context);
    const cached = this.cache.get(key);

    if (!cached) return null;

    // Validate cache is still valid
    if (await this.isValid(cached, context)) {
      // Move to end (LRU)
      this.cache.delete(key);
      this.cache.set(key, cached);
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
    
    // Enforce size limit (LRU eviction)
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      location,
      context,
      timestamp: Date.now(),
    });
  }

  private generateKey(reference: string, context: CacheContext): string {
    const parts = [
      reference,
      context.prNumber.toString(),
      context.fileHash,
      context.commitSha || '',
    ];

    return createHash('sha256')
      .update(parts.join('|'))
      .digest('hex')
      .substring(0, 16);
  }

  private async isValid(
    cached: CachedLocation,
    currentContext: CacheContext
  ): Promise<boolean> {
    // Check if file has changed
    if (cached.context.fileHash !== currentContext.fileHash) {
      return false;
    }

    // Check if commit has changed
    if (
      currentContext.commitSha &&
      cached.context.commitSha &&
      cached.context.commitSha !== currentContext.commitSha
    ) {
      return false;
    }

    // Check if too old
    if (Date.now() - cached.timestamp > this.maxAge) {
      return false;
    }

    return true;
  }

  clear(): void {
    this.cache.clear();
  }

  clearOld(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [key, cached] of this.cache.entries()) {
      if (now - cached.timestamp > this.maxAge) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.cache.delete(key);
    }
  }

  size(): number {
    return this.cache.size;
  }

  setMaxAge(ms: number): void {
    this.maxAge = ms;
  }

  setMaxSize(size: number): void {
    this.maxSize = size;
  }

  // Stats for monitoring
  getStats(): {
    size: number;
    maxSize: number;
    oldestAge: number;
    newestAge: number;
  } {
    const now = Date.now();
    let oldest = 0;
    let newest = Infinity;

    for (const cached of this.cache.values()) {
      const age = now - cached.timestamp;
      oldest = Math.max(oldest, age);
      newest = Math.min(newest, age);
    }

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      oldestAge: oldest,
      newestAge: newest === Infinity ? 0 : newest,
    };
  }
}