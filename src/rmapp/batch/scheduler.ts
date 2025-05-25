import type { Octokit } from 'octokit';
import type { 
  BatchOperation, 
  BatchOptions, 
  BatchItem, 
  ScheduledItem,
  RunningItem,
  ItemResult
} from './types.js';
import { DependencyGraph } from './dependency_graph.js';
import { ResourceManager } from './resource_manager.js';
import { PriorityQueue } from './priority_queue.js';
// TODO: Replace with actual implementations when available
// import { IssueAnalyzer } from '../analyzer/issue_analyzer.js';
// import { IssueImplementor } from '../implementor/issue_implementor.js';
import { ReviewResponsePipeline } from '../responder/pipeline.js';

export class BatchScheduler {
  private queue: PriorityQueue<ScheduledItem>;
  private running = new Map<string, RunningItem>();
  private completed = new Set<string>();
  private failed = new Set<string>();
  private dependencyGraph?: DependencyGraph;
  
  constructor(
    private octokit: Octokit,
    private owner: string,
    private repo: string,
    private resourceManager: ResourceManager,
    private options: BatchOptions
  ) {
    this.queue = new PriorityQueue<ScheduledItem>();
  }
  
  async schedule(batch: BatchOperation): Promise<void> {
    // Build dependency graph
    this.dependencyGraph = new DependencyGraph();
    this.dependencyGraph.addItems(batch.items);
    
    // Get execution levels
    const levels = this.dependencyGraph.getExecutionOrder();
    
    // Schedule each level
    for (let level = 0; level < levels.length; level++) {
      const items = levels[level].map(id => 
        batch.items.find(item => item.id === id)!
      );
      
      // Add to queue with priority
      for (const item of items) {
        // Calculate effective priority (lower level = higher priority)
        const effectivePriority = level * 1000 + (100 - item.priority);
        
        this.queue.enqueue({
          item,
          level,
          priority: effectivePriority,
          batch: batch.id
        }, effectivePriority);
      }
    }
    
    // Start processing
    await this.processQueue(batch);
  }
  
  private async processQueue(batch: BatchOperation): Promise<void> {
    while (!this.queue.isEmpty() || this.running.size > 0) {
      // Check concurrency limit
      if (this.running.size >= this.options.concurrency) {
        await this.waitForSlot();
        continue;
      }
      
      // Get next item
      const scheduled = this.queue.dequeue();
      if (!scheduled) {
        if (this.running.size > 0) {
          await this.waitForSlot();
        }
        continue;
      }
      
      // Check dependencies
      if (!this.areDependenciesComplete(scheduled.item)) {
        // Check if dependencies failed
        if (this.hasDependencyFailed(scheduled.item)) {
          scheduled.item.status = 'skipped';
          scheduled.item.result = {
            summary: 'Skipped due to failed dependency',
            error: 'One or more dependencies failed'
          };
          continue;
        }
        
        // Re-queue for later
        this.queue.enqueue(scheduled, scheduled.priority);
        await this.delay(100);
        continue;
      }
      
      // Process item asynchronously
      this.processItem(scheduled, batch).catch(error => {
        console.error(`Error processing item ${scheduled.item.id}:`, error);
      });
    }
  }
  
  private async processItem(
    scheduled: ScheduledItem, 
    batch: BatchOperation
  ): Promise<void> {
    const { item } = scheduled;
    
    try {
      // Acquire resources
      const resources = await this.resourceManager.acquireResources(item);
      
      // Set up timeout if specified
      let timeoutHandle: NodeJS.Timeout | undefined;
      if (this.options.timeout) {
        timeoutHandle = setTimeout(() => {
          this.handleTimeout(item);
        }, this.options.timeout);
      }
      
      // Mark as running
      item.status = 'running';
      item.startTime = Date.now();
      this.running.set(item.id, {
        item,
        resources,
        startTime: Date.now(),
        timeout: timeoutHandle
      });
      
      // Execute based on type
      const result = await this.executeItem(item, resources);
      
      // Clear timeout
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      
      // Update status
      item.status = 'completed';
      item.endTime = Date.now();
      item.result = result;
      this.completed.add(item.id);
      
    } catch (error) {
      // Handle failure
      item.status = 'failed';
      item.endTime = Date.now();
      item.result = { 
        summary: 'Execution failed',
        error: error instanceof Error ? error.message : String(error),
        duration: item.endTime - (item.startTime || Date.now())
      };
      this.failed.add(item.id);
      
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
  
  private async executeItem(
    item: BatchItem,
    resources: { workspace: string }
  ): Promise<ItemResult> {
    console.log(`Executing ${item.type} item: ${item.reference}`);
    
    switch (item.type) {
      case 'issue':
        return this.executeIssue(item, resources.workspace);
      
      case 'pr':
      case 'review':
        return this.executePRReview(item, resources.workspace);
      
      default:
        throw new Error(`Unknown item type: ${item.type}`);
    }
  }
  
  private async executeIssue(
    item: BatchItem,
    workspace: string
  ): Promise<ItemResult> {
    const issueNumber = typeof item.reference === 'number' 
      ? item.reference 
      : parseInt(item.reference, 10);
    
    // TODO: Implement when IssueAnalyzer and IssueImplementor are available
    console.log(`Would implement issue #${issueNumber} in workspace ${workspace}`);
    
    // For now, return a placeholder result
    return {
      summary: `Issue #${issueNumber} implementation placeholder`,
      details: {
        message: 'Issue implementation not yet available'
      },
      workspace,
      commits: [],
      artifacts: [],
      duration: Date.now() - (item.startTime || Date.now())
    };
  }
  
  private async executePRReview(
    item: BatchItem,
    workspace: string  
  ): Promise<ItemResult> {
    const prNumber = typeof item.reference === 'number' 
      ? item.reference 
      : parseInt(item.reference, 10);
    
    // Process PR reviews
    const responder = new ReviewResponsePipeline(
      this.octokit,
      this.owner,
      this.repo
    );
    
    const result = await responder.respondToReviews({
      owner: this.owner,
      repo: this.repo,
      number: prNumber,
      workspace,
      baseBranch: 'main',
      headBranch: `pr-${prNumber}`
    });
    
    return {
      summary: `Processed ${result.responses.length} reviews on PR #${prNumber}`,
      details: {
        responses: result.summary,
        commits: result.commits
      },
      workspace,
      commits: result.commits.map((c: any) => c.sha),
      artifacts: result.commits.map(c => ({
        type: 'commit' as const,
        reference: c.sha,
        description: c.message.split('\n')[0]
      })),
      duration: Date.now() - (item.startTime || Date.now())
    };
  }
  
  private areDependenciesComplete(item: BatchItem): boolean {
    if (!item.dependencies || item.dependencies.length === 0) {
      return true;
    }
    
    for (const dep of item.dependencies) {
      if (!this.completed.has(dep)) {
        return false;
      }
    }
    
    return true;
  }
  
  private hasDependencyFailed(item: BatchItem): boolean {
    if (!item.dependencies) return false;
    
    for (const dep of item.dependencies) {
      if (this.failed.has(dep)) {
        return true;
      }
    }
    
    return false;
  }
  
  private async waitForSlot(): Promise<void> {
    return new Promise(resolve => {
      const checkSlot = setInterval(() => {
        if (this.running.size < this.options.concurrency) {
          clearInterval(checkSlot);
          resolve();
        }
      }, 100);
    });
  }
  
  private handleTimeout(item: BatchItem): void {
    console.error(`Item ${item.id} timed out`);
    
    // Mark as failed
    item.status = 'failed';
    item.endTime = Date.now();
    item.result = {
      summary: 'Execution timed out',
      error: `Exceeded timeout of ${this.options.timeout}ms`,
      duration: item.endTime - (item.startTime || Date.now())
    };
    
    // Remove from running
    const running = this.running.get(item.id);
    if (running) {
      running.resources.release().catch(console.error);
      this.running.delete(item.id);
    }
    
    this.failed.add(item.id);
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  getStatus() {
    return {
      queued: this.queue.size(),
      running: this.running.size,
      completed: this.completed.size,
      failed: this.failed.size,
      runningItems: Array.from(this.running.keys())
    };
  }
  
  async cancel(): Promise<void> {
    // Clear queue
    this.queue.clear();
    
    // Cancel running items
    for (const [id, running] of this.running) {
      if (running.timeout) {
        clearTimeout(running.timeout);
      }
      
      const item = running.item;
      item.status = 'failed';
      item.result = {
        summary: 'Cancelled',
        error: 'Batch operation was cancelled'
      };
      
      await running.resources.release();
    }
    
    this.running.clear();
  }
}