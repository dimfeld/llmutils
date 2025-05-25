import EventEmitter from 'events';
import type { 
  BatchProgress, 
  ItemStatus, 
  ProgressEvent, 
  ProgressListener 
} from './types.js';

export class BatchProgressTracker extends EventEmitter {
  private progress = new Map<string, BatchProgress>();
  private itemTracking = new Map<string, Map<string, ItemStatus>>();
  private updateInterval?: NodeJS.Timeout;
  
  constructor(private updateFrequency: number = 1000) {
    super();
  }
  
  startBatch(batchId: string, total: number): void {
    const progress: BatchProgress = {
      total,
      completed: 0,
      failed: 0,
      running: 0,
      skipped: 0,
      startTime: new Date(),
      estimatedCompletion: this.estimateCompletion(total, 0, new Date())
    };
    
    this.progress.set(batchId, progress);
    this.itemTracking.set(batchId, new Map());
    
    this.emitProgress(batchId, 'start', progress);
    
    // Start periodic updates
    if (!this.updateInterval) {
      this.updateInterval = setInterval(() => {
        this.updateEstimates();
      }, this.updateFrequency);
    }
  }
  
  updateItem(batchId: string, itemId: string, status: ItemStatus): void {
    const progress = this.progress.get(batchId);
    const items = this.itemTracking.get(batchId);
    
    if (!progress || !items) return;
    
    const previousStatus = items.get(itemId);
    items.set(itemId, status);
    
    // Update counters based on status transition
    if (previousStatus) {
      // Decrement old status counter
      this.decrementStatus(progress, previousStatus);
    }
    
    // Increment new status counter
    this.incrementStatus(progress, status);
    
    // Update estimate
    progress.estimatedCompletion = this.updateEstimate(progress);
    
    // Emit update
    this.emitProgress(batchId, 'progress', progress);
    
    // Check if complete
    const total = progress.completed + progress.failed + progress.skipped;
    if (total === progress.total) {
      this.emitProgress(batchId, 'complete', progress);
      this.cleanup(batchId);
    }
  }
  
  private incrementStatus(progress: BatchProgress, status: ItemStatus): void {
    switch (status) {
      case 'running':
        progress.running++;
        break;
      case 'completed':
        progress.completed++;
        break;
      case 'failed':
        progress.failed++;
        break;
      case 'skipped':
        progress.skipped++;
        break;
    }
  }
  
  private decrementStatus(progress: BatchProgress, status: ItemStatus): void {
    switch (status) {
      case 'running':
        progress.running = Math.max(0, progress.running - 1);
        break;
      case 'completed':
        progress.completed = Math.max(0, progress.completed - 1);
        break;
      case 'failed':
        progress.failed = Math.max(0, progress.failed - 1);
        break;
      case 'skipped':
        progress.skipped = Math.max(0, progress.skipped - 1);
        break;
    }
  }
  
  private updateEstimate(progress: BatchProgress): Date {
    const elapsed = Date.now() - progress.startTime.getTime();
    const processed = progress.completed + progress.failed + progress.skipped;
    
    if (processed === 0) {
      // Initial estimate based on typical processing time
      const avgTimePerItem = 30000; // 30 seconds default
      return new Date(Date.now() + avgTimePerItem * progress.total);
    }
    
    // Calculate based on actual progress
    const avgTime = elapsed / processed;
    const remaining = progress.total - processed;
    const estimatedRemaining = avgTime * remaining;
    
    // Add buffer for currently running items
    const runningBuffer = progress.running * avgTime * 0.5;
    
    return new Date(Date.now() + estimatedRemaining + runningBuffer);
  }
  
  private estimateCompletion(total: number, completed: number, startTime: Date): Date {
    if (completed === 0) {
      // Initial estimate
      const avgTimePerItem = 30000; // 30 seconds
      return new Date(Date.now() + avgTimePerItem * total);
    }
    
    const elapsed = Date.now() - startTime.getTime();
    const avgTime = elapsed / completed;
    const remaining = total - completed;
    
    return new Date(Date.now() + avgTime * remaining);
  }
  
  private updateEstimates(): void {
    for (const [batchId, progress] of this.progress) {
      const oldEstimate = progress.estimatedCompletion?.getTime();
      progress.estimatedCompletion = this.updateEstimate(progress);
      
      // Only emit if estimate changed significantly (> 1 minute)
      if (!oldEstimate || 
          Math.abs(progress.estimatedCompletion.getTime() - oldEstimate) > 60000) {
        this.emitProgress(batchId, 'progress', progress);
      }
    }
  }
  
  subscribe(batchId: string, listener: ProgressListener): () => void {
    const eventName = `batch-${batchId}`;
    
    const wrappedListener = (data: { event: ProgressEvent; progress: BatchProgress }) => {
      listener(data.event, data.progress);
    };
    
    this.on(eventName, wrappedListener);
    
    // Send current state if exists
    const currentProgress = this.progress.get(batchId);
    if (currentProgress) {
      listener('progress', currentProgress);
    }
    
    // Return unsubscribe function
    return () => {
      this.off(eventName, wrappedListener);
    };
  }
  
  private emitProgress(batchId: string, event: ProgressEvent, progress: BatchProgress): void {
    this.emit(`batch-${batchId}`, { event, progress });
    this.emit('progress', { batchId, event, progress });
  }
  
  getProgress(batchId: string): BatchProgress | undefined {
    return this.progress.get(batchId);
  }
  
  getAllProgress(): Map<string, BatchProgress> {
    return new Map(this.progress);
  }
  
  getItemStatuses(batchId: string): Map<string, ItemStatus> | undefined {
    return this.itemTracking.get(batchId);
  }
  
  private cleanup(batchId: string): void {
    // Keep progress for a while for reference
    setTimeout(() => {
      this.progress.delete(batchId);
      this.itemTracking.delete(batchId);
    }, 300000); // 5 minutes
    
    // Stop update interval if no active batches
    if (this.progress.size === 0 && this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }
  }
  
  formatProgress(progress: BatchProgress): string {
    const percentage = Math.round((progress.completed / progress.total) * 100);
    const elapsed = Date.now() - progress.startTime.getTime();
    const elapsedStr = this.formatDuration(elapsed);
    
    let status = `Progress: ${percentage}% (${progress.completed}/${progress.total})`;
    status += `\nElapsed: ${elapsedStr}`;
    
    if (progress.running > 0) {
      status += `\nRunning: ${progress.running}`;
    }
    
    if (progress.failed > 0) {
      status += `\nFailed: ${progress.failed}`;
    }
    
    if (progress.skipped > 0) {
      status += `\nSkipped: ${progress.skipped}`;
    }
    
    if (progress.estimatedCompletion && progress.completed < progress.total) {
      const remaining = progress.estimatedCompletion.getTime() - Date.now();
      if (remaining > 0) {
        status += `\nEstimated completion: ${this.formatDuration(remaining)}`;
      }
    }
    
    return status;
  }
  
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
  
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }
    
    this.removeAllListeners();
    this.progress.clear();
    this.itemTracking.clear();
  }
}