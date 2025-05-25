import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { IssueAnalyzer } from '../../analysis/issue_analyzer.js';
import { PlanGenerator } from '../../planning/plan_generator.js';
import { ReviewParser } from '../../reviews/review_parser.js';
import { CodeLocator } from '../../locator/code_locator.js';
import { ContextPipeline } from '../../context/pipeline.js';
import { PatternDetector } from '../../learning/pattern_detector.js';
import { fixtures } from '../fixtures.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface BenchmarkResult {
  name: string;
  operations: number;
  totalTime: number;
  avgTime: number;
  minTime: number;
  maxTime: number;
  opsPerSecond: number;
}

class Benchmark {
  private results: BenchmarkResult[] = [];
  
  async run(
    name: string,
    fn: () => Promise<any>,
    iterations: number = 100
  ): Promise<BenchmarkResult> {
    const times: number[] = [];
    
    // Warmup
    for (let i = 0; i < 10; i++) {
      await fn();
    }
    
    // Actual benchmark
    const startTotal = performance.now();
    
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await fn();
      const end = performance.now();
      times.push(end - start);
    }
    
    const endTotal = performance.now();
    const totalTime = endTotal - startTotal;
    
    const result: BenchmarkResult = {
      name,
      operations: iterations,
      totalTime,
      avgTime: totalTime / iterations,
      minTime: Math.min(...times),
      maxTime: Math.max(...times),
      opsPerSecond: (iterations / totalTime) * 1000
    };
    
    this.results.push(result);
    return result;
  }
  
  printResults(): void {
    console.log('\n=== Performance Benchmark Results ===\n');
    
    const headers = ['Operation', 'Ops/sec', 'Avg (ms)', 'Min (ms)', 'Max (ms)'];
    const rows = this.results.map(r => [
      r.name,
      r.opsPerSecond.toFixed(2),
      r.avgTime.toFixed(3),
      r.minTime.toFixed(3),
      r.maxTime.toFixed(3)
    ]);
    
    // Print table
    console.table(rows.reduce((acc, row, i) => {
      acc[this.results[i].name] = {
        'Ops/sec': row[1],
        'Avg (ms)': row[2],
        'Min (ms)': row[3],
        'Max (ms)': row[4]
      };
      return acc;
    }, {} as any));
  }
}

describe('Performance Benchmarks', () => {
  const benchmark = new Benchmark();
  let analyzer: IssueAnalyzer;
  let generator: PlanGenerator;
  let parser: ReviewParser;
  let locator: CodeLocator;
  let contextPipeline: ContextPipeline;
  let patternDetector: PatternDetector;
  
  beforeEach(async () => {
    analyzer = new IssueAnalyzer();
    generator = new PlanGenerator();
    parser = new ReviewParser();
    locator = new CodeLocator();
    contextPipeline = new ContextPipeline({ cache: { enabled: false } });
    patternDetector = new PatternDetector();
    
    await contextPipeline.initialize();
  });
  
  afterEach(() => {
    benchmark.printResults();
  });
  
  describe('Issue Analysis Performance', () => {
    it('should benchmark simple issue analysis', async () => {
      const result = await benchmark.run(
        'Simple Issue Analysis',
        async () => {
          await analyzer.analyze(fixtures.issues.simple);
        },
        100
      );
      
      expect(result.avgTime).toBeLessThan(50); // Should complete in < 50ms
      expect(result.opsPerSecond).toBeGreaterThan(20);
    });
    
    it('should benchmark complex issue analysis', async () => {
      const result = await benchmark.run(
        'Complex Issue Analysis',
        async () => {
          await analyzer.analyze(fixtures.issues.complex);
        },
        100
      );
      
      expect(result.avgTime).toBeLessThan(100); // Should complete in < 100ms
      expect(result.opsPerSecond).toBeGreaterThan(10);
    });
  });
  
  describe('Plan Generation Performance', () => {
    const analyzedIssue = fixtures.analyzedIssues.simple;
    
    it('should benchmark plan generation', async () => {
      const result = await benchmark.run(
        'Plan Generation',
        async () => {
          await generator.generatePlan(analyzedIssue, {
            workspace: '/tmp/test',
            preferences: {}
          });
        },
        50
      );
      
      expect(result.avgTime).toBeLessThan(200);
      expect(result.opsPerSecond).toBeGreaterThan(5);
    });
  });
  
  describe('Review Parsing Performance', () => {
    it('should benchmark review comment parsing', async () => {
      const result = await benchmark.run(
        'Review Parsing',
        async () => {
          await parser.parseReview({
            pr: 124,
            comments: fixtures.reviews.complex
          });
        },
        100
      );
      
      expect(result.avgTime).toBeLessThan(30);
      expect(result.opsPerSecond).toBeGreaterThan(30);
    });
  });
  
  describe('Code Location Performance', () => {
    beforeEach(async () => {
      // Build index
      await locator.indexFiles({
        'src/auth/jwt.ts': fixtures.files['src/auth/jwt.ts'],
        'src/data/processor.ts': fixtures.files['src/data/processor.ts']
      });
    });
    
    it('should benchmark code location finding', async () => {
      const result = await benchmark.run(
        'Code Location',
        async () => {
          await locator.findLocation({
            file: 'src/auth/jwt.ts',
            line: 42,
            content: 'error handling'
          });
        },
        200
      );
      
      expect(result.avgTime).toBeLessThan(10);
      expect(result.opsPerSecond).toBeGreaterThan(100);
    });
    
    it('should benchmark fuzzy location matching', async () => {
      const result = await benchmark.run(
        'Fuzzy Location',
        async () => {
          await locator.findLocationFuzzy(
            'processData function needs refactoring',
            ['src/data/processor.ts']
          );
        },
        100
      );
      
      expect(result.avgTime).toBeLessThan(50);
      expect(result.opsPerSecond).toBeGreaterThan(20);
    });
  });
  
  describe('Context Gathering Performance', () => {
    it('should benchmark context search', async () => {
      // Create test contexts
      const contexts = Array.from({ length: 1000 }, (_, i) => ({
        id: `ctx-${i}`,
        type: i % 2 === 0 ? 'code' : 'documentation',
        source: { type: 'file', location: `file-${i}.ts` },
        content: `Content for context ${i} with authentication and JWT tokens`,
        metadata: { file: `file-${i}.ts` },
        relevance: Math.random(),
        timestamp: new Date()
      }));
      
      const result = await benchmark.run(
        'Context Search',
        async () => {
          await contextPipeline.searchAll('authentication JWT', {
            limit: 10
          });
        },
        50
      );
      
      expect(result.avgTime).toBeLessThan(100);
      expect(result.opsPerSecond).toBeGreaterThan(10);
    });
  });
  
  describe('Pattern Detection Performance', () => {
    it('should benchmark pattern detection', async () => {
      // Create test events
      const events = Array.from({ length: 100 }, (_, i) => ({
        id: `evt-${i}`,
        type: 'code_generation',
        timestamp: new Date(),
        context: {
          generatedCode: fixtures.files['src/auth/jwt.ts']
        },
        action: {
          id: `act-${i}`,
          type: 'generate_code',
          target: 'auth',
          parameters: {},
          timestamp: new Date()
        },
        outcome: {
          success: true,
          duration: 1000 + Math.random() * 1000
        }
      }));
      
      const result = await benchmark.run(
        'Pattern Detection',
        async () => {
          await patternDetector.detectPatterns(events as any);
        },
        20
      );
      
      expect(result.avgTime).toBeLessThan(500);
      expect(result.opsPerSecond).toBeGreaterThan(2);
    });
  });
  
  describe('Memory Usage', () => {
    it('should measure memory usage for large operations', async () => {
      const initialMemory = process.memoryUsage();
      
      // Process many issues
      const issues = Array.from({ length: 1000 }, (_, i) => ({
        ...fixtures.issues.simple,
        number: i,
        title: `Issue ${i}`,
        body: `Body for issue ${i}`.repeat(100)
      }));
      
      const startTime = performance.now();
      
      for (const issue of issues) {
        await analyzer.analyze(issue);
      }
      
      const endTime = performance.now();
      const finalMemory = process.memoryUsage();
      
      const memoryIncrease = {
        heapUsed: (finalMemory.heapUsed - initialMemory.heapUsed) / 1024 / 1024,
        external: (finalMemory.external - initialMemory.external) / 1024 / 1024,
        rss: (finalMemory.rss - initialMemory.rss) / 1024 / 1024
      };
      
      console.log('\nMemory Usage:');
      console.log(`Heap Used: +${memoryIncrease.heapUsed.toFixed(2)} MB`);
      console.log(`External: +${memoryIncrease.external.toFixed(2)} MB`);
      console.log(`RSS: +${memoryIncrease.rss.toFixed(2)} MB`);
      console.log(`Total Time: ${(endTime - startTime).toFixed(2)} ms`);
      console.log(`Avg per Issue: ${((endTime - startTime) / issues.length).toFixed(3)} ms`);
      
      // Memory increase should be reasonable
      expect(memoryIncrease.heapUsed).toBeLessThan(100); // Less than 100MB
    });
  });
  
  describe('Concurrent Operations', () => {
    it('should benchmark concurrent issue processing', async () => {
      const issues = Array.from({ length: 50 }, (_, i) => ({
        ...fixtures.issues.simple,
        number: i
      }));
      
      // Sequential processing
      const sequentialStart = performance.now();
      for (const issue of issues) {
        await analyzer.analyze(issue);
      }
      const sequentialTime = performance.now() - sequentialStart;
      
      // Concurrent processing
      const concurrentStart = performance.now();
      await Promise.all(
        issues.map(issue => analyzer.analyze(issue))
      );
      const concurrentTime = performance.now() - concurrentStart;
      
      console.log('\nConcurrency Comparison:');
      console.log(`Sequential: ${sequentialTime.toFixed(2)} ms`);
      console.log(`Concurrent: ${concurrentTime.toFixed(2)} ms`);
      console.log(`Speedup: ${(sequentialTime / concurrentTime).toFixed(2)}x`);
      
      // Concurrent should be faster
      expect(concurrentTime).toBeLessThan(sequentialTime);
      expect(sequentialTime / concurrentTime).toBeGreaterThan(2); // At least 2x speedup
    });
  });
});

// Export benchmark utility for use in other tests
export { Benchmark };