import type { PlanStep, PlanContext, DependencyGraph } from './types.js';
import { log } from '../../logging.js';

export class PlanOptimizer {
  optimize(steps: PlanStep[], context: PlanContext): PlanStep[] {
    // Create a copy to avoid modifying the original
    let optimizedSteps = [...steps];
    
    // Detect dependencies between steps
    const depGraph = this.detectDependencies(optimizedSteps);
    
    // Order by dependencies
    optimizedSteps = this.orderByDependencies(optimizedSteps, depGraph);
    
    // Balance step complexity
    optimizedSteps = this.balanceComplexity(optimizedSteps);
    
    // Add parallel markers where possible
    optimizedSteps = this.markParallelSteps(optimizedSteps, depGraph);
    
    // Inject context at right points
    optimizedSteps = this.optimizeContextDistribution(optimizedSteps, context);
    
    // Merge related steps if too granular
    optimizedSteps = this.mergeRelatedSteps(optimizedSteps);
    
    return optimizedSteps;
  }

  private detectDependencies(steps: PlanStep[]): DependencyGraph {
    const nodes = new Map<string, PlanStep>();
    const edges = new Map<string, Set<string>>();
    
    // Create nodes
    steps.forEach((step, index) => {
      const id = `step-${index + 1}`;
      nodes.set(id, step);
      edges.set(id, new Set());
    });
    
    // Detect explicit dependencies
    steps.forEach((step, index) => {
      const id = `step-${index + 1}`;
      if (step.dependencies) {
        step.dependencies.forEach(dep => {
          edges.get(id)?.add(dep);
        });
      }
    });
    
    // Detect implicit dependencies based on content
    steps.forEach((step, index) => {
      const id = `step-${index + 1}`;
      
      // Check if this step mentions files modified by previous steps
      steps.forEach((prevStep, prevIndex) => {
        if (prevIndex >= index) return;
        
        const prevId = `step-${prevIndex + 1}`;
        if (this.hasFileDependency(step, prevStep)) {
          edges.get(id)?.add(prevId);
        }
      });
    });
    
    return { nodes, edges };
  }

  private hasFileDependency(step: PlanStep, prevStep: PlanStep): boolean {
    if (!step.context_files || !prevStep.context_files) return false;
    
    // Check if they share files
    const stepFiles = new Set(step.context_files);
    return prevStep.context_files.some(file => stepFiles.has(file));
  }

  private orderByDependencies(steps: PlanStep[], depGraph: DependencyGraph): PlanStep[] {
    // Topological sort
    const visited = new Set<string>();
    const result: PlanStep[] = [];
    
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      
      // Visit dependencies first
      const deps = depGraph.edges.get(id) || new Set();
      deps.forEach(dep => visit(dep));
      
      // Then add this node
      const step = depGraph.nodes.get(id);
      if (step) result.push(step);
    };
    
    // Visit all nodes
    depGraph.nodes.forEach((step, id) => visit(id));
    
    return result;
  }

  private balanceComplexity(steps: PlanStep[]): PlanStep[] {
    const balanced: PlanStep[] = [];
    
    for (const step of steps) {
      if (step.estimated_complexity === 'high' && step.acceptance_criteria.length > 5) {
        // Split complex step
        const splitSteps = this.splitComplexStep(step);
        balanced.push(...splitSteps);
      } else if (
        step.estimated_complexity === 'low' && 
        balanced.length > 0 && 
        balanced[balanced.length - 1].estimated_complexity === 'low'
      ) {
        // Consider merging with previous low-complexity step
        const prev = balanced[balanced.length - 1];
        if (this.canMergeSteps(prev, step)) {
          balanced[balanced.length - 1] = this.mergeSteps(prev, step);
        } else {
          balanced.push(step);
        }
      } else {
        balanced.push(step);
      }
    }
    
    return balanced;
  }

  private splitComplexStep(step: PlanStep): PlanStep[] {
    const midpoint = Math.ceil(step.acceptance_criteria.length / 2);
    
    const step1: PlanStep = {
      ...step,
      title: `${step.title} (Part 1)`,
      acceptance_criteria: step.acceptance_criteria.slice(0, midpoint),
      estimated_complexity: 'medium',
    };
    
    const step2: PlanStep = {
      ...step,
      title: `${step.title} (Part 2)`,
      acceptance_criteria: step.acceptance_criteria.slice(midpoint),
      estimated_complexity: 'medium',
      dependencies: [`step-${Date.now()}`], // Temporary ID
    };
    
    return [step1, step2];
  }

  private canMergeSteps(step1: PlanStep, step2: PlanStep): boolean {
    // Don't merge if they have different file contexts
    const files1 = new Set(step1.context_files || []);
    const files2 = new Set(step2.context_files || []);
    const overlap = [...files1].filter(f => files2.has(f)).length;
    
    // Merge if they work on similar files
    return overlap > files1.size * 0.5;
  }

  private mergeSteps(step1: PlanStep, step2: PlanStep): PlanStep {
    return {
      title: `${step1.title} and ${step2.title}`,
      description: `${step1.description}\n\n${step2.description}`,
      acceptance_criteria: [
        ...step1.acceptance_criteria,
        ...step2.acceptance_criteria,
      ],
      technical_notes: [step1.technical_notes, step2.technical_notes]
        .filter(Boolean)
        .join('. '),
      estimated_complexity: 'medium',
      dependencies: [
        ...(step1.dependencies || []),
        ...(step2.dependencies || []),
      ],
      context_files: [
        ...new Set([
          ...(step1.context_files || []),
          ...(step2.context_files || []),
        ]),
      ],
      rmfilter_args: step1.rmfilter_args || step2.rmfilter_args,
    };
  }

  private markParallelSteps(steps: PlanStep[], depGraph: DependencyGraph): PlanStep[] {
    // Find steps that can run in parallel
    const marked = [...steps];
    
    for (let i = 0; i < marked.length; i++) {
      const step = marked[i];
      const id = `step-${i + 1}`;
      const deps = depGraph.edges.get(id) || new Set();
      
      // Check if this step can run in parallel with the next one
      if (i < marked.length - 1) {
        const nextId = `step-${i + 2}`;
        const nextDeps = depGraph.edges.get(nextId) || new Set();
        
        // If neither depends on the other, they can be parallel
        if (!deps.has(nextId) && !nextDeps.has(id)) {
          step.parallel = true;
          marked[i + 1].parallel = true;
        }
      }
    }
    
    return marked;
  }

  private optimizeContextDistribution(steps: PlanStep[], context: PlanContext): PlanStep[] {
    // Ensure context files are distributed appropriately
    const optimized = [...steps];
    
    // Add examples to implementation steps
    const exampleFiles = context.examples.map(e => e.file);
    optimized.forEach(step => {
      if (step.title.toLowerCase().includes('implement') && exampleFiles.length > 0) {
        step.context_files = [
          ...(step.context_files || []),
          ...exampleFiles.slice(0, 2), // Add up to 2 examples
        ];
      }
    });
    
    // Add test files to test steps
    const testFiles = context.tests.map(t => t.file);
    optimized.forEach(step => {
      if (step.title.toLowerCase().includes('test') && testFiles.length > 0) {
        step.context_files = [
          ...(step.context_files || []),
          ...testFiles,
        ];
      }
    });
    
    // Remove duplicates
    optimized.forEach(step => {
      if (step.context_files) {
        step.context_files = [...new Set(step.context_files)];
      }
    });
    
    return optimized;
  }

  private mergeRelatedSteps(steps: PlanStep[]): PlanStep[] {
    if (steps.length <= 3) return steps; // Don't merge if already minimal
    
    const merged: PlanStep[] = [];
    let i = 0;
    
    while (i < steps.length) {
      const current = steps[i];
      
      // Look for mergeable next step
      if (
        i < steps.length - 1 &&
        current.estimated_complexity === 'low' &&
        steps[i + 1].estimated_complexity === 'low' &&
        this.canMergeSteps(current, steps[i + 1])
      ) {
        merged.push(this.mergeSteps(current, steps[i + 1]));
        i += 2; // Skip next step
      } else {
        merged.push(current);
        i++;
      }
    }
    
    return merged;
  }
}