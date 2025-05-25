import { execSync } from 'child_process';
import type { BatchItem, Resources, ResourceLimits, WorkspaceInfo } from './types.js';
import { createWorkspace } from '../../rmplan/workspace/workspace_manager.js';
import { readTrackingData, type WorkspaceInfo as TrackedWorkspaceInfo } from '../../rmplan/workspace/workspace_tracker.js';
import { mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

interface RateLimiterOptions {
  points: number;
  duration: number; // in seconds
}

class RateLimiter {
  private points: number;
  private maxPoints: number;
  private duration: number;
  private resetTime: number;
  
  constructor(options: RateLimiterOptions) {
    this.maxPoints = options.points;
    this.points = options.points;
    this.duration = options.duration * 1000; // Convert to ms
    this.resetTime = Date.now() + this.duration;
  }
  
  async consume(points: number): Promise<void> {
    // Reset if duration has passed
    if (Date.now() >= this.resetTime) {
      this.points = this.maxPoints;
      this.resetTime = Date.now() + this.duration;
    }
    
    // Wait if not enough points
    while (this.points < points) {
      const waitTime = this.resetTime - Date.now();
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, 1000)));
      }
      
      // Check for reset again
      if (Date.now() >= this.resetTime) {
        this.points = this.maxPoints;
        this.resetTime = Date.now() + this.duration;
      }
    }
    
    this.points -= points;
  }
  
  get remainingPoints(): number {
    // Reset if needed
    if (Date.now() >= this.resetTime) {
      this.points = this.maxPoints;
      this.resetTime = Date.now() + this.duration;
    }
    return this.points;
  }
}

interface WorkspacePoolOptions {
  maxConcurrent: number;
  cleanupOnRelease: boolean;
  baseDir?: string;
}

class WorkspacePool {
  private available: WorkspaceInfo[] = [];
  private inUse = new Map<string, WorkspaceInfo>();
  private workspaceCounter = 0;
  
  constructor(
    private options: WorkspacePoolOptions,
    private owner: string,
    private repo: string
  ) {}
  
  async initialize(): Promise<void> {
    // Create initial pool of workspaces
    const baseDir = this.options.baseDir || path.join(process.env.HOME!, '.rmfilter/batch-workspaces');
    
    if (!existsSync(baseDir)) {
      await mkdir(baseDir, { recursive: true });
    }
  }
  
  async acquire(): Promise<string> {
    // Wait if at capacity
    while (this.inUse.size >= this.options.maxConcurrent && this.available.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Reuse available workspace
    let workspace = this.available.pop();
    
    if (!workspace) {
      // Create new workspace
      const workspaceId = `batch-${this.workspaceCounter++}-${Date.now()}`;
      const baseDir = this.options.baseDir || path.join(process.env.HOME!, '.rmfilter/batch-workspaces');
      const workspacePath = path.join(baseDir, workspaceId);
      
      // Clone repository
      await mkdir(workspacePath, { recursive: true });
      execSync(`git clone https://github.com/${this.owner}/${this.repo} .`, {
        cwd: workspacePath,
        encoding: 'utf-8'
      });
      
      // Create branch
      const branch = `batch-${workspaceId}`;
      execSync(`git checkout -b ${branch}`, {
        cwd: workspacePath,
        encoding: 'utf-8'
      });
      
      workspace = {
        id: workspaceId,
        path: workspacePath,
        inUse: true,
        lastUsed: new Date(),
        branch
      };
    }
    
    workspace.inUse = true;
    workspace.lastUsed = new Date();
    this.inUse.set(workspace.id, workspace);
    
    return workspace.path;
  }
  
  async release(workspacePath: string): Promise<void> {
    // Find workspace info
    let workspace: WorkspaceInfo | undefined;
    
    for (const [id, ws] of this.inUse) {
      if (ws.path === workspacePath) {
        workspace = ws;
        this.inUse.delete(id);
        break;
      }
    }
    
    if (!workspace) return;
    
    workspace.inUse = false;
    
    if (this.options.cleanupOnRelease) {
      // Reset workspace to clean state
      try {
        execSync('git reset --hard HEAD && git clean -fd', {
          cwd: workspace.path,
          encoding: 'utf-8'
        });
      } catch (error) {
        console.error('Failed to clean workspace:', error);
      }
    }
    
    // Add back to available pool
    this.available.push(workspace);
  }
  
  async cleanup(): Promise<void> {
    // Clean up all workspaces
    const allWorkspaces = [...this.available, ...Array.from(this.inUse.values())];
    
    for (const workspace of allWorkspaces) {
      if (existsSync(workspace.path)) {
        await rm(workspace.path, { recursive: true, force: true });
      }
    }
    
    this.available = [];
    this.inUse.clear();
  }
  
  getStats() {
    return {
      available: this.available.length,
      inUse: this.inUse.size,
      total: this.available.length + this.inUse.size
    };
  }
}

interface MemoryMonitorOptions {
  maxUsage: number; // Percentage (0-1)
  checkInterval: number; // ms
}

class MemoryMonitor {
  private interval?: NodeJS.Timeout;
  private currentUsage = 0;
  
  constructor(private options: MemoryMonitorOptions) {
    this.startMonitoring();
  }
  
  private startMonitoring(): void {
    this.interval = setInterval(() => {
      const usage = process.memoryUsage();
      const totalMemory = process.resourceUsage().maxRSS * 1024; // Convert to bytes
      this.currentUsage = usage.heapUsed / totalMemory;
    }, this.options.checkInterval);
  }
  
  isAboveThreshold(): boolean {
    return this.currentUsage > this.options.maxUsage;
  }
  
  async waitForMemory(): Promise<void> {
    while (this.isAboveThreshold()) {
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  getCurrentUsage(): number {
    return this.currentUsage;
  }
  
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }
}

export class ResourceManager {
  private apiRateLimit: RateLimiter;
  private workspacePool: WorkspacePool;
  private memoryMonitor: MemoryMonitor;
  private apiCallCounter = 0;
  
  constructor(
    private owner: string,
    private repo: string,
    private limits?: ResourceLimits
  ) {
    // Initialize rate limiter with GitHub's limits
    this.apiRateLimit = new RateLimiter({
      points: limits?.maxApiCalls || 5000,
      duration: 3600 // 1 hour
    });
    
    // Initialize workspace pool
    this.workspacePool = new WorkspacePool(
      {
        maxConcurrent: limits?.maxWorkspaces || 5,
        cleanupOnRelease: true
      },
      owner,
      repo
    );
    
    // Initialize memory monitor
    this.memoryMonitor = new MemoryMonitor({
      maxUsage: (limits?.maxMemoryUsage || 80) / 100,
      checkInterval: 5000
    });
  }
  
  async initialize(): Promise<void> {
    await this.workspacePool.initialize();
  }
  
  async acquireResources(item: BatchItem): Promise<Resources> {
    // Estimate API calls needed
    const estimatedCalls = this.estimateApiCalls(item);
    
    // Check API rate limit
    await this.apiRateLimit.consume(estimatedCalls);
    this.apiCallCounter += estimatedCalls;
    
    // Check memory
    if (this.memoryMonitor.isAboveThreshold()) {
      await this.memoryMonitor.waitForMemory();
    }
    
    // Acquire workspace
    const workspace = await this.workspacePool.acquire();
    
    return {
      workspace,
      apiQuota: this.apiRateLimit.remainingPoints,
      release: async () => {
        await this.workspacePool.release(workspace);
      }
    };
  }
  
  private estimateApiCalls(item: BatchItem): number {
    const estimates: Record<string, number> = {
      issue_simple: 10,
      issue_complex: 50,
      pr_review_small: 20,
      pr_review_large: 100
    };
    
    // Classify based on type and assumed complexity
    const classification = this.classifyItem(item);
    return estimates[classification] || 30;
  }
  
  private classifyItem(item: BatchItem): string {
    if (item.type === 'issue') {
      // Could analyze issue body/labels to determine complexity
      return 'issue_simple';
    } else if (item.type === 'pr' || item.type === 'review') {
      // Could check PR size to determine complexity
      return 'pr_review_small';
    }
    
    return 'issue_simple';
  }
  
  async releaseAll(): Promise<void> {
    await this.workspacePool.cleanup();
  }
  
  getResourceUsage() {
    return {
      apiCalls: this.apiCallCounter,
      apiQuotaRemaining: this.apiRateLimit.remainingPoints,
      memoryUsage: this.memoryMonitor.getCurrentUsage(),
      workspaceStats: this.workspacePool.getStats()
    };
  }
  
  stop(): void {
    this.memoryMonitor.stop();
  }
}