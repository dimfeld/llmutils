import type { Octokit } from 'octokit';
import { randomUUID } from 'crypto';
import type { 
  BatchOperation, 
  BatchItem, 
  BatchOptions, 
  BatchResults,
  ProgressListener,
  BatchStatus
} from './types.js';
import { BatchScheduler } from './scheduler.js';
import { BatchProgressTracker } from './progress_tracker.js';
import { BatchResultAggregator } from './result_aggregator.js';
import { BatchRecoveryHandler } from './recovery.js';
import { ResourceManager } from './resource_manager.js';

export interface BatchServiceOptions {
  owner: string;
  repo: string;
  octokit: Octokit;
  resourceLimits?: {
    maxApiCalls?: number;
    maxMemoryUsage?: number;
    maxWorkspaces?: number;
  };
  stateDir?: string;
}

export class BatchService {
  private scheduler: BatchScheduler;
  private tracker: BatchProgressTracker;
  private aggregator: BatchResultAggregator;
  private recovery: BatchRecoveryHandler;
  private resourceManager: ResourceManager;
  private activeBatches = new Map<string, BatchOperation>();
  
  constructor(private options: BatchServiceOptions) {
    this.resourceManager = new ResourceManager(
      options.owner,
      options.repo,
      options.resourceLimits
    );
    
    this.scheduler = new BatchScheduler(
      options.octokit,
      options.owner,
      options.repo,
      this.resourceManager,
      {} as BatchOptions // Will be set per batch
    );
    
    this.tracker = new BatchProgressTracker();
    this.aggregator = new BatchResultAggregator();
    this.recovery = new BatchRecoveryHandler(options.stateDir);
    
    // Set up progress tracking
    this.setupProgressTracking();
  }
  
  async initialize(): Promise<void> {
    await this.resourceManager.initialize();
  }
  
  async executeBatch(
    items: BatchItem[],
    options: BatchOptions
  ): Promise<BatchResults> {
    // Validate items
    this.validateItems(items);
    
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
        skipped: 0,
        startTime: new Date()
      },
      results: {
        successful: [],
        failed: [],
        skipped: [],
        summary: {
          totalItems: items.length,
          successCount: 0,
          failureCount: 0,
          skippedCount: 0,
          duration: 0,
          byType: new Map()
        }
      }
    };
    
    // Register batch
    this.activeBatches.set(batch.id, batch);
    
    // Save initial state for recovery
    await this.recovery.saveBatchState(batch);
    
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
      // Create scheduler with batch options
      const scheduler = new BatchScheduler(
        this.options.octokit,
        this.options.owner,
        this.options.repo,
        this.resourceManager,
        options
      );
      
      // Execute
      await scheduler.schedule(batch);
      
      // Wait for completion
      await this.waitForCompletion(batch.id);
      
      // Aggregate results
      const resourceUsage = this.resourceManager.getResourceUsage();
      const results = this.aggregator.aggregate(batch.items, {
        apiCalls: resourceUsage.apiCalls,
        peakMemory: process.memoryUsage().heapUsed,
        workspacesUsed: resourceUsage.workspaceStats.total
      });
      
      // Update batch
      batch.status = 'completed';
      batch.results = results;
      
      // Save final state
      await this.recovery.saveBatchState(batch);
      
      return results;
      
    } catch (error) {
      // Handle batch failure
      batch.status = 'failed';
      await this.recovery.saveBatchState(batch);
      throw error;
      
    } finally {
      unsubscribe();
      this.activeBatches.delete(batch.id);
    }
  }
  
  async recoverBatch(batchId: string): Promise<BatchResults | null> {
    // Load recovery batch
    const recoveryBatch = await this.recovery.recoverBatch(batchId);
    if (!recoveryBatch) {
      return null;
    }
    
    console.log(`Recovering batch ${batchId} with ${recoveryBatch.items.length} items`);
    
    // Execute recovery
    return this.executeBatch(recoveryBatch.items, recoveryBatch.options);
  }
  
  async cancelBatch(batchId: string): Promise<void> {
    const batch = this.activeBatches.get(batchId);
    if (!batch) {
      throw new Error(`Batch ${batchId} not found`);
    }
    
    batch.status = 'cancelled';
    
    // Cancel scheduler
    // Note: This would need to be implemented in the scheduler
    console.log(`Cancelling batch ${batchId}`);
    
    // Update all pending/running items
    for (const item of batch.items) {
      if (item.status === 'pending' || item.status === 'running') {
        item.status = 'skipped';
        item.result = {
          summary: 'Batch cancelled',
          error: 'Batch operation was cancelled by user'
        };
      }
    }
    
    // Save state
    await this.recovery.saveBatchState(batch);
  }
  
  getBatchStatus(batchId: string): BatchOperation | undefined {
    return this.activeBatches.get(batchId);
  }
  
  getActiveBatches(): BatchOperation[] {
    return Array.from(this.activeBatches.values());
  }
  
  async getRecoverableBatches() {
    return this.recovery.listRecoverableBatches();
  }
  
  subscribeToProgress(batchId: string, listener: ProgressListener): () => void {
    return this.tracker.subscribe(batchId, listener);
  }
  
  generateReport(results: BatchResults): string {
    return this.aggregator.generateReport(results);
  }
  
  private validateItems(items: BatchItem[]): void {
    if (items.length === 0) {
      throw new Error('Batch must contain at least one item');
    }
    
    const ids = new Set<string>();
    
    for (const item of items) {
      // Check for duplicate IDs
      if (ids.has(item.id)) {
        throw new Error(`Duplicate item ID: ${item.id}`);
      }
      ids.add(item.id);
      
      // Validate dependencies
      if (item.dependencies) {
        for (const dep of item.dependencies) {
          if (!ids.has(dep) && !items.find(i => i.id === dep)) {
            throw new Error(`Item ${item.id} depends on unknown item: ${dep}`);
          }
        }
      }
      
      // Set default status
      if (!item.status) {
        item.status = 'pending';
      }
    }
  }
  
  private inferBatchType(items: BatchItem[]): BatchOperation['type'] {
    const types = new Set(items.map(i => i.type));
    
    if (types.size === 1) {
      const type = types.values().next().value;
      return type === 'issue' ? 'issue_implementation' : 'pr_review';
    }
    
    return 'mixed';
  }
  
  private generateBatchId(): string {
    return `batch-${Date.now()}-${randomUUID().substring(0, 8)}`;
  }
  
  private setupProgressTracking(): void {
    // Listen to all progress events for saving state
    this.tracker.on('progress', async ({ batchId, event }) => {
      const batch = this.activeBatches.get(batchId);
      if (batch && (event === 'progress' || event === 'complete')) {
        // Periodically save state
        await this.recovery.saveBatchState(batch);
      }
    });
  }
  
  private handleProgressUpdate(
    batch: BatchOperation,
    event: string,
    progress: any
  ): void {
    // Update batch progress
    batch.progress = { ...batch.progress, ...progress };
    
    // Update item statuses
    const itemStatuses = this.tracker.getItemStatuses(batch.id);
    if (itemStatuses) {
      for (const [itemId, status] of itemStatuses) {
        const item = batch.items.find(i => i.id === itemId);
        if (item) {
          item.status = status;
        }
      }
    }
  }
  
  private async waitForCompletion(batchId: string): Promise<void> {
    return new Promise((resolve) => {
      const unsubscribe = this.tracker.subscribe(batchId, (event) => {
        if (event === 'complete') {
          unsubscribe();
          resolve();
        }
      });
    });
  }
  
  async cleanup(): Promise<void> {
    // Cancel all active batches
    for (const batch of this.activeBatches.values()) {
      await this.cancelBatch(batch.id);
    }
    
    // Clean up resources
    await this.resourceManager.releaseAll();
    this.resourceManager.stop();
    this.tracker.stop();
    
    // Clean up old recovery states
    await this.recovery.cleanupOldStates();
  }
}