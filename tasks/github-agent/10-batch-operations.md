# Batch Operations

## Overview
Implement support for processing multiple issues, PRs, and reviews in batch operations with intelligent scheduling and resource management.

## Requirements
- Process multiple issues concurrently
- Handle dependencies between issues
- Manage resource limits (API rate limits, concurrent workspaces)
- Provide batch progress tracking
- Support batch cancellation and recovery

## Implementation Steps

### Step 1: Define Batch Types
Create types in `src/rmapp/batch/types.ts`:
```typescript
interface BatchOperation {
  id: string;
  type: 'issue_implementation' | 'pr_review' | 'mixed';
  items: BatchItem[];
  options: BatchOptions;
  status: BatchStatus;
  progress: BatchProgress;
  results: BatchResults;
}

interface BatchItem {
  id: string;
  type: 'issue' | 'pr' | 'review';
  reference: string | number;
  dependencies?: string[];
  priority: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: ItemResult;
}

interface BatchOptions {
  concurrency: number;
  stopOnError: boolean;
  timeout?: number;
  retryPolicy?: RetryPolicy;
  resourceLimits?: ResourceLimits;
}

interface BatchProgress {
  total: number;
  completed: number;
  failed: number;
  running: number;
  startTime: Date;
  estimatedCompletion?: Date;
}
```

### Step 2: Build Dependency Graph
Implement `src/rmapp/batch/dependency_graph.ts`:
```typescript
class DependencyGraph {
  private graph = new Map<string, Set<string>>();
  private reverseGraph = new Map<string, Set<string>>();
  
  addItem(item: BatchItem): void {
    if (!this.graph.has(item.id)) {
      this.graph.set(item.id, new Set());
      this.reverseGraph.set(item.id, new Set());
    }
    
    // Add dependencies
    for (const dep of item.dependencies || []) {
      this.graph.get(item.id)!.add(dep);
      
      if (!this.reverseGraph.has(dep)) {
        this.reverseGraph.set(dep, new Set());
      }
      this.reverseGraph.get(dep)!.add(item.id);
    }
  }
  
  getExecutionOrder(): string[][] {
    // Topological sort with level grouping
    const levels: string[][] = [];
    const visited = new Set<string>();
    const inDegree = new Map<string, number>();
    
    // Calculate in-degrees
    for (const [node, _] of this.graph) {
      inDegree.set(node, this.getDependencies(node).size);
    }
    
    // Find nodes with no dependencies
    let currentLevel = Array.from(this.graph.keys())
      .filter(node => inDegree.get(node) === 0);
    
    while (currentLevel.length > 0) {
      levels.push(currentLevel);
      const nextLevel: string[] = [];
      
      for (const node of currentLevel) {
        visited.add(node);
        
        // Update in-degrees of dependents
        for (const dependent of this.getDependents(node)) {
          const newDegree = inDegree.get(dependent)! - 1;
          inDegree.set(dependent, newDegree);
          
          if (newDegree === 0 && !visited.has(dependent)) {
            nextLevel.push(dependent);
          }
        }
      }
      
      currentLevel = nextLevel;
    }
    
    // Check for cycles
    if (visited.size < this.graph.size) {
      throw new Error('Circular dependency detected');
    }
    
    return levels;
  }
}
```

### Step 3: Create Resource Manager
Build `src/rmapp/batch/resource_manager.ts`:
```typescript
class ResourceManager {
  private apiRateLimit = new RateLimiter({
    points: 5000, // GitHub API limit
    duration: 3600, // per hour
  });
  
  private workspacePool = new WorkspacePool({
    maxConcurrent: 5,
    cleanupOnRelease: true
  });
  
  private memoryMonitor = new MemoryMonitor({
    maxUsage: 0.8, // 80% of available memory
    checkInterval: 5000
  });
  
  async acquireResources(item: BatchItem): Promise<Resources> {
    // Check API rate limit
    await this.apiRateLimit.consume(this.estimateApiCalls(item));
    
    // Acquire workspace
    const workspace = await this.workspacePool.acquire();
    
    // Check memory
    if (this.memoryMonitor.isAboveThreshold()) {
      await this.waitForMemory();
    }
    
    return {
      workspace,
      apiQuota: this.apiRateLimit.remainingPoints,
      release: async () => {
        await this.workspacePool.release(workspace);
      }
    };
  }
  
  private estimateApiCalls(item: BatchItem): number {
    const estimates = {
      issue_simple: 10,
      issue_complex: 50,
      pr_review_small: 20,
      pr_review_large: 100
    };
    
    // Estimate based on item type and complexity
    return estimates[this.classifyItem(item)] || 30;
  }
}
```

### Step 4: Implement Batch Scheduler
Create `src/rmapp/batch/scheduler.ts`:
```typescript
class BatchScheduler {
  private queue = new PriorityQueue<ScheduledItem>();
  private running = new Map<string, RunningItem>();
  
  constructor(
    private resourceManager: ResourceManager,
    private options: BatchOptions
  ) {}
  
  async schedule(batch: BatchOperation): Promise<void> {
    // Build dependency graph
    const graph = new DependencyGraph();
    for (const item of batch.items) {
      graph.addItem(item);
    }
    
    // Get execution levels
    const levels = graph.getExecutionOrder();
    
    // Schedule each level
    for (let level = 0; level < levels.length; level++) {
      const items = levels[level].map(id => 
        batch.items.find(item => item.id === id)!
      );
      
      // Add to queue with priority
      for (const item of items) {
        this.queue.enqueue({
          item,
          level,
          priority: item.priority,
          batch: batch.id
        });
      }
    }
    
    // Start processing
    await this.processQueue();
  }
  
  private async processQueue(): Promise<void> {
    while (!this.queue.isEmpty() || this.running.size > 0) {
      // Check concurrency limit
      if (this.running.size >= this.options.concurrency) {
        await this.waitForSlot();
        continue;
      }
      
      // Get next item
      const scheduled = this.queue.dequeue();
      if (!scheduled) {
        await this.waitForSlot();
        continue;
      }
      
      // Check dependencies
      if (!this.areDependenciesComplete(scheduled.item)) {
        // Re-queue for later
        this.queue.enqueue(scheduled);
        await this.delay(100);
        continue;
      }
      
      // Process item
      this.processItem(scheduled);
    }
  }
  
  private async processItem(scheduled: ScheduledItem): Promise<void> {
    const { item } = scheduled;
    
    try {
      // Acquire resources
      const resources = await this.resourceManager.acquireResources(item);
      
      // Mark as running
      this.running.set(item.id, {
        item,
        resources,
        startTime: Date.now()
      });
      
      // Execute based on type
      const result = await this.executeItem(item, resources);
      
      // Update status
      item.status = 'completed';
      item.result = result;
      
    } catch (error) {
      // Handle failure
      item.status = 'failed';
      item.result = { error: error.message };
      
      if (this.options.stopOnError) {
        throw error;
      }
    } finally {
      // Release resources
      const running = this.running.get(item.id);
      if (running) {
        await running.resources.release();
        this.running.delete(item.id);
      }
    }
  }
}
```

### Step 5: Create Progress Tracker
Implement `src/rmapp/batch/progress_tracker.ts`:
```typescript
class BatchProgressTracker {
  private progress = new Map<string, BatchProgress>();
  private listeners = new Map<string, ProgressListener[]>();
  
  startBatch(batchId: string, total: number): void {
    this.progress.set(batchId, {
      total,
      completed: 0,
      failed: 0,
      running: 0,
      startTime: new Date(),
      estimatedCompletion: this.estimateCompletion(total)
    });
    
    this.emit(batchId, 'start', this.progress.get(batchId)!);
  }
  
  updateItem(batchId: string, itemId: string, status: ItemStatus): void {
    const progress = this.progress.get(batchId);
    if (!progress) return;
    
    // Update counters
    if (status === 'running') {
      progress.running++;
    } else if (status === 'completed') {
      progress.completed++;
      progress.running--;
    } else if (status === 'failed') {
      progress.failed++;
      progress.running--;
    }
    
    // Update estimate
    progress.estimatedCompletion = this.updateEstimate(progress);
    
    // Emit update
    this.emit(batchId, 'progress', progress);
    
    // Check if complete
    if (progress.completed + progress.failed === progress.total) {
      this.emit(batchId, 'complete', progress);
    }
  }
  
  private updateEstimate(progress: BatchProgress): Date {
    const elapsed = Date.now() - progress.startTime.getTime();
    const completed = progress.completed + progress.failed;
    
    if (completed === 0) {
      return new Date(Date.now() + 3600000); // Default 1 hour
    }
    
    const avgTime = elapsed / completed;
    const remaining = progress.total - completed;
    const estimatedRemaining = avgTime * remaining;
    
    return new Date(Date.now() + estimatedRemaining);
  }
  
  subscribe(batchId: string, listener: ProgressListener): () => void {
    if (!this.listeners.has(batchId)) {
      this.listeners.set(batchId, []);
    }
    
    this.listeners.get(batchId)!.push(listener);
    
    // Return unsubscribe function
    return () => {
      const listeners = this.listeners.get(batchId);
      if (listeners) {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      }
    };
  }
}
```

### Step 6: Build Batch Result Aggregator
Create `src/rmapp/batch/result_aggregator.ts`:
```typescript
class BatchResultAggregator {
  aggregate(items: BatchItem[]): BatchResults {
    const results: BatchResults = {
      successful: [],
      failed: [],
      summary: {
        totalItems: items.length,
        successCount: 0,
        failureCount: 0,
        duration: 0,
        byType: new Map()
      }
    };
    
    // Categorize results
    for (const item of items) {
      if (item.status === 'completed') {
        results.successful.push({
          item,
          result: item.result!,
          duration: item.result!.duration
        });
        results.summary.successCount++;
      } else if (item.status === 'failed') {
        results.failed.push({
          item,
          error: item.result?.error || 'Unknown error',
          canRetry: this.canRetry(item)
        });
        results.summary.failureCount++;
      }
      
      // Update type summary
      const typeSummary = results.summary.byType.get(item.type) || {
        total: 0,
        success: 0,
        failed: 0
      };
      typeSummary.total++;
      if (item.status === 'completed') typeSummary.success++;
      if (item.status === 'failed') typeSummary.failed++;
      results.summary.byType.set(item.type, typeSummary);
    }
    
    // Calculate total duration
    const startTime = Math.min(...items.map(i => i.startTime || Date.now()));
    const endTime = Math.max(...items.map(i => i.endTime || Date.now()));
    results.summary.duration = endTime - startTime;
    
    return results;
  }
  
  generateReport(results: BatchResults): string {
    const report = ['# Batch Operation Report\n'];
    
    // Summary
    report.push('## Summary');
    report.push(`- Total items: ${results.summary.totalItems}`);
    report.push(`- Successful: ${results.summary.successCount}`);
    report.push(`- Failed: ${results.summary.failureCount}`);
    report.push(`- Duration: ${this.formatDuration(results.summary.duration)}`);
    report.push('');
    
    // By type breakdown
    report.push('## Breakdown by Type');
    for (const [type, summary] of results.summary.byType) {
      report.push(`- ${type}: ${summary.success}/${summary.total} succeeded`);
    }
    report.push('');
    
    // Successful items
    if (results.successful.length > 0) {
      report.push('## Successful Items');
      for (const success of results.successful) {
        report.push(`- ${success.item.reference}: ${success.result.summary}`);
      }
      report.push('');
    }
    
    // Failed items
    if (results.failed.length > 0) {
      report.push('## Failed Items');
      for (const failure of results.failed) {
        report.push(`- ${failure.item.reference}: ${failure.error}`);
        if (failure.canRetry) {
          report.push('  (Can be retried)');
        }
      }
    }
    
    return report.join('\n');
  }
}
```

### Step 7: Create Batch Recovery Handler
Implement `src/rmapp/batch/recovery.ts`:
```typescript
class BatchRecoveryHandler {
  async recoverBatch(batchId: string): Promise<BatchOperation> {
    // Load batch state
    const state = await this.loadBatchState(batchId);
    
    // Identify incomplete items
    const incomplete = state.items.filter(
      item => item.status === 'running' || item.status === 'pending'
    );
    
    // Check workspace states
    for (const item of incomplete) {
      if (item.status === 'running') {
        const canResume = await this.checkWorkspace(item);
        if (!canResume) {
          // Reset to pending
          item.status = 'pending';
          item.result = undefined;
        }
      }
    }
    
    // Create recovery batch
    const recoveryBatch: BatchOperation = {
      id: `${batchId}-recovery`,
      type: state.type,
      items: incomplete,
      options: {
        ...state.options,
        isRecovery: true
      },
      status: 'pending',
      progress: {
        total: incomplete.length,
        completed: 0,
        failed: 0,
        running: 0,
        startTime: new Date()
      },
      results: {}
    };
    
    return recoveryBatch;
  }
  
  private async checkWorkspace(item: BatchItem): Promise<boolean> {
    if (!item.workspaceId) return false;
    
    try {
      // Check if workspace exists and is valid
      const workspace = await this.workspaceManager.get(item.workspaceId);
      
      // Check git status
      const status = await this.getGitStatus(workspace);
      
      // Can resume if no uncommitted changes
      return status.isClean;
    } catch {
      return false;
    }
  }
}
```

### Step 8: Build Batch Service
Combine in `src/rmapp/batch/service.ts`:
```typescript
class BatchService {
  constructor(
    private scheduler: BatchScheduler,
    private tracker: BatchProgressTracker,
    private aggregator: BatchResultAggregator,
    private recovery: BatchRecoveryHandler
  ) {}
  
  async executeBatch(
    items: BatchItem[],
    options: BatchOptions
  ): Promise<BatchResults> {
    // Create batch operation
    const batch: BatchOperation = {
      id: this.generateBatchId(),
      type: this.inferBatchType(items),
      items,
      options,
      status: 'running',
      progress: {
        total: items.length,
        completed: 0,
        failed: 0,
        running: 0,
        startTime: new Date()
      },
      results: {}
    };
    
    // Save batch state
    await this.saveBatchState(batch);
    
    // Start tracking
    this.tracker.startBatch(batch.id, items.length);
    
    // Subscribe to progress
    const unsubscribe = this.tracker.subscribe(
      batch.id,
      (event, progress) => {
        this.handleProgressUpdate(batch, event, progress);
      }
    );
    
    try {
      // Execute
      await this.scheduler.schedule(batch);
      
      // Aggregate results
      const results = this.aggregator.aggregate(batch.items);
      
      // Save final state
      batch.status = 'completed';
      batch.results = results;
      await this.saveBatchState(batch);
      
      return results;
      
    } catch (error) {
      // Handle batch failure
      batch.status = 'failed';
      await this.saveBatchState(batch);
      throw error;
      
    } finally {
      unsubscribe();
    }
  }
  
  async recoverBatch(batchId: string): Promise<BatchResults> {
    // Create recovery batch
    const recovery = await this.recovery.recoverBatch(batchId);
    
    // Execute recovery
    return this.executeBatch(recovery.items, recovery.options);
  }
}
```

## Testing Strategy
1. Test dependency graph construction
2. Test resource management
3. Test concurrent execution
4. Test failure handling
5. Test recovery mechanisms
6. Load test with many items

## Success Criteria
- [ ] Handles dependencies correctly
- [ ] Respects concurrency limits
- [ ] Manages resources efficiently
- [ ] Provides accurate progress tracking
- [ ] Recovers from failures gracefully