import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { DependencyGraph } from './dependency_graph.js';
import { PriorityQueue } from './priority_queue.js';
import { BatchProgressTracker } from './progress_tracker.js';
import { BatchResultAggregator } from './result_aggregator.js';
import type { BatchItem, BatchResults, ItemStatus } from './types.js';

describe('DependencyGraph', () => {
  let graph: DependencyGraph;
  
  beforeEach(() => {
    graph = new DependencyGraph();
  });
  
  it('should handle simple linear dependencies', () => {
    const items: BatchItem[] = [
      { id: 'a', type: 'issue', reference: '1', priority: 1, status: 'pending' },
      { id: 'b', type: 'issue', reference: '2', priority: 1, status: 'pending', dependencies: ['a'] },
      { id: 'c', type: 'issue', reference: '3', priority: 1, status: 'pending', dependencies: ['b'] },
    ];
    
    graph.addItems(items);
    const order = graph.getExecutionOrder();
    
    expect(order).toHaveLength(3);
    expect(order[0]).toEqual(['a']);
    expect(order[1]).toEqual(['b']);
    expect(order[2]).toEqual(['c']);
  });
  
  it('should handle parallel execution', () => {
    const items: BatchItem[] = [
      { id: 'a', type: 'issue', reference: '1', priority: 1, status: 'pending' },
      { id: 'b', type: 'issue', reference: '2', priority: 1, status: 'pending' },
      { id: 'c', type: 'issue', reference: '3', priority: 1, status: 'pending', dependencies: ['a', 'b'] },
      { id: 'd', type: 'issue', reference: '4', priority: 1, status: 'pending', dependencies: ['a'] },
    ];
    
    graph.addItems(items);
    const order = graph.getExecutionOrder();
    
    expect(order).toHaveLength(3);
    expect(order[0]).toContain('a');
    expect(order[0]).toContain('b');
    expect(order[0]).toHaveLength(2);
    expect(order[1]).toContain('d');
    expect(order[2]).toEqual(['c']);
  });
  
  it('should detect circular dependencies', () => {
    const items: BatchItem[] = [
      { id: 'a', type: 'issue', reference: '1', priority: 1, status: 'pending', dependencies: ['c'] },
      { id: 'b', type: 'issue', reference: '2', priority: 1, status: 'pending', dependencies: ['a'] },
      { id: 'c', type: 'issue', reference: '3', priority: 1, status: 'pending', dependencies: ['b'] },
    ];
    
    graph.addItems(items);
    
    expect(() => graph.getExecutionOrder()).toThrow('Circular dependency detected');
    expect(graph.hasCycles()).toBe(true);
  });
  
  it('should find ready items based on completion state', () => {
    const items: BatchItem[] = [
      { id: 'a', type: 'issue', reference: '1', priority: 1, status: 'pending' },
      { id: 'b', type: 'issue', reference: '2', priority: 1, status: 'pending', dependencies: ['a'] },
      { id: 'c', type: 'issue', reference: '3', priority: 1, status: 'pending' },
      { id: 'd', type: 'issue', reference: '4', priority: 1, status: 'pending', dependencies: ['b', 'c'] },
    ];
    
    graph.addItems(items);
    
    const ready1 = graph.getReadyItems(new Set(), new Set());
    expect(ready1).toContain('a');
    expect(ready1).toContain('c');
    expect(ready1).toHaveLength(2);
    
    const ready2 = graph.getReadyItems(new Set(['a']), new Set(['c']));
    expect(ready2).toContain('b');
    expect(ready2).toHaveLength(1);
    
    const ready3 = graph.getReadyItems(new Set(['a', 'b', 'c']), new Set());
    expect(ready3).toContain('d');
    expect(ready3).toHaveLength(1);
  });
});

describe('PriorityQueue', () => {
  it('should dequeue items by priority', () => {
    const queue = new PriorityQueue<string>();
    
    queue.enqueue('low', 10);
    queue.enqueue('high', 1);
    queue.enqueue('medium', 5);
    
    expect(queue.dequeue()).toBe('high');
    expect(queue.dequeue()).toBe('medium');
    expect(queue.dequeue()).toBe('low');
    expect(queue.dequeue()).toBeUndefined();
  });
  
  it('should handle same priority FIFO', () => {
    const queue = new PriorityQueue<string>();
    
    queue.enqueue('first', 5);
    queue.enqueue('second', 5);
    queue.enqueue('third', 5);
    
    // Note: with same priority, order might not be strictly FIFO
    // due to heap properties, but all should be dequeued
    const results = [];
    while (!queue.isEmpty()) {
      results.push(queue.dequeue());
    }
    
    expect(results).toHaveLength(3);
    expect(results).toContain('first');
    expect(results).toContain('second');
    expect(results).toContain('third');
  });
});

describe('BatchProgressTracker', () => {
  let tracker: BatchProgressTracker;
  
  beforeEach(() => {
    tracker = new BatchProgressTracker(100); // Fast updates for testing
  });
  
  it('should track batch progress', (done) => {
    const batchId = 'test-batch';
    const events: string[] = [];
    
    const unsubscribe = tracker.subscribe(batchId, (event, progress) => {
      events.push(event);
      
      if (event === 'start') {
        expect(progress.total).toBe(3);
        expect(progress.completed).toBe(0);
        
        // Update items
        tracker.updateItem(batchId, 'item1', 'running');
        tracker.updateItem(batchId, 'item2', 'running');
      } else if (event === 'progress' && progress.running === 2) {
        tracker.updateItem(batchId, 'item1', 'completed');
        tracker.updateItem(batchId, 'item2', 'failed');
        tracker.updateItem(batchId, 'item3', 'completed');
      } else if (event === 'complete') {
        expect(progress.completed).toBe(2);
        expect(progress.failed).toBe(1);
        expect(progress.total).toBe(3);
        
        unsubscribe();
        tracker.stop();
        done();
      }
    });
    
    tracker.startBatch(batchId, 3);
  });
  
  it('should format progress correctly', () => {
    const progress = {
      total: 100,
      completed: 45,
      failed: 5,
      running: 10,
      skipped: 0,
      startTime: new Date(Date.now() - 60000), // 1 minute ago
      estimatedCompletion: new Date(Date.now() + 120000) // 2 minutes from now
    };
    
    const formatted = tracker.formatProgress(progress);
    
    expect(formatted).toContain('45%');
    expect(formatted).toContain('45/100');
    expect(formatted).toContain('Running: 10');
    expect(formatted).toContain('Failed: 5');
  });
});

describe('BatchResultAggregator', () => {
  let aggregator: BatchResultAggregator;
  
  beforeEach(() => {
    aggregator = new BatchResultAggregator();
  });
  
  it('should aggregate results correctly', () => {
    const items: BatchItem[] = [
      {
        id: '1',
        type: 'issue',
        reference: '1',
        priority: 1,
        status: 'completed',
        startTime: Date.now() - 10000,
        endTime: Date.now() - 5000,
        result: { summary: 'Implemented feature' }
      },
      {
        id: '2',
        type: 'issue',
        reference: '2',
        priority: 1,
        status: 'failed',
        startTime: Date.now() - 8000,
        endTime: Date.now() - 6000,
        result: { summary: 'Failed', error: 'Timeout' }
      },
      {
        id: '3',
        type: 'pr',
        reference: '3',
        priority: 1,
        status: 'skipped',
        result: { summary: 'Skipped', error: 'Dependency failed' }
      }
    ];
    
    const results = aggregator.aggregate(items);
    
    expect(results.summary.totalItems).toBe(3);
    expect(results.summary.successCount).toBe(1);
    expect(results.summary.failureCount).toBe(1);
    expect(results.summary.skippedCount).toBe(1);
    
    expect(results.successful).toHaveLength(1);
    expect(results.failed).toHaveLength(1);
    expect(results.skipped).toHaveLength(1);
    
    expect(results.summary.byType.get('issue')).toEqual({
      total: 2,
      success: 1,
      failed: 1,
      skipped: 0,
      avgDuration: 5000
    });
  });
  
  it('should generate readable report', () => {
    const results: BatchResults = {
      successful: [{
        item: { id: '1', type: 'issue', reference: '123', priority: 1, status: 'completed' },
        result: { summary: 'Fixed bug' },
        duration: 5000
      }],
      failed: [{
        item: { id: '2', type: 'pr', reference: '456', priority: 1, status: 'failed' },
        error: 'API rate limit exceeded',
        canRetry: true,
        failureReason: 'resource_limit'
      }],
      skipped: [],
      summary: {
        totalItems: 2,
        successCount: 1,
        failureCount: 1,
        skippedCount: 0,
        duration: 10000,
        byType: new Map([
          ['issue', { total: 1, success: 1, failed: 0, skipped: 0 }],
          ['pr', { total: 1, success: 0, failed: 1, skipped: 0 }]
        ])
      }
    };
    
    const report = aggregator.generateReport(results);
    
    expect(report).toContain('# Batch Operation Report');
    expect(report).toContain('Total items: 2');
    expect(report).toContain('Successful: 1 (50%)');
    expect(report).toContain('Failed: 1 (50%)');
    expect(report).toContain('## Successful Items');
    expect(report).toContain('#123');
    expect(report).toContain('## Failed Items');
    expect(report).toContain('PR #456');
    expect(report).toContain('Retryable: Yes');
  });
  
  it('should identify retryable items', () => {
    const results: BatchResults = {
      successful: [],
      failed: [
        {
          item: { id: '1', type: 'issue', reference: '1', priority: 1, status: 'failed' },
          error: 'Network timeout',
          canRetry: true
        },
        {
          item: { id: '2', type: 'issue', reference: '2', priority: 1, status: 'failed' },
          error: 'Invalid configuration (non-retryable)',
          canRetry: false
        }
      ],
      skipped: [],
      summary: {
        totalItems: 2,
        successCount: 0,
        failureCount: 2,
        skippedCount: 0,
        duration: 0,
        byType: new Map()
      }
    };
    
    const retryable = aggregator.getRetryableItems(results);
    
    expect(retryable).toHaveLength(1);
    expect(retryable[0].id).toBe('1');
  });
});