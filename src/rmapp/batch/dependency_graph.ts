import type { BatchItem } from './types.js';

export class DependencyGraph {
  private graph = new Map<string, Set<string>>();
  private reverseGraph = new Map<string, Set<string>>();
  private items = new Map<string, BatchItem>();
  
  addItem(item: BatchItem): void {
    // Store the item
    this.items.set(item.id, item);
    
    // Initialize graph entries
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
  
  addItems(items: BatchItem[]): void {
    for (const item of items) {
      this.addItem(item);
    }
  }
  
  getDependencies(itemId: string): Set<string> {
    return this.graph.get(itemId) || new Set();
  }
  
  getDependents(itemId: string): Set<string> {
    return this.reverseGraph.get(itemId) || new Set();
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
      const unvisited = Array.from(this.graph.keys()).filter(k => !visited.has(k));
      throw new Error(`Circular dependency detected involving: ${unvisited.join(', ')}`);
    }
    
    return levels;
  }
  
  hasCycles(): boolean {
    try {
      this.getExecutionOrder();
      return false;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Circular dependency')) {
        return true;
      }
      throw error;
    }
  }
  
  getTransitiveDependencies(itemId: string): Set<string> {
    const dependencies = new Set<string>();
    const visited = new Set<string>();
    
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      
      for (const dep of this.getDependencies(id)) {
        dependencies.add(dep);
        visit(dep);
      }
    };
    
    visit(itemId);
    return dependencies;
  }
  
  canExecute(itemId: string, completedItems: Set<string>): boolean {
    const dependencies = this.getDependencies(itemId);
    
    for (const dep of dependencies) {
      if (!completedItems.has(dep)) {
        return false;
      }
    }
    
    return true;
  }
  
  getItem(itemId: string): BatchItem | undefined {
    return this.items.get(itemId);
  }
  
  getAllItems(): BatchItem[] {
    return Array.from(this.items.values());
  }
  
  size(): number {
    return this.graph.size;
  }
  
  clear(): void {
    this.graph.clear();
    this.reverseGraph.clear();
    this.items.clear();
  }
  
  // Visualize the graph for debugging
  toDot(): string {
    const lines = ['digraph BatchDependencies {'];
    
    // Add nodes
    for (const [id, item] of this.items) {
      const label = `${id}\\n(${item.type}: ${item.reference})`;
      lines.push(`  "${id}" [label="${label}"];`);
    }
    
    // Add edges
    for (const [from, tos] of this.graph) {
      for (const to of tos) {
        lines.push(`  "${from}" -> "${to}";`);
      }
    }
    
    lines.push('}');
    return lines.join('\n');
  }
  
  // Find all paths between two nodes
  findPaths(fromId: string, toId: string): string[][] {
    const paths: string[][] = [];
    const currentPath: string[] = [];
    const visited = new Set<string>();
    
    const dfs = (current: string) => {
      if (current === toId) {
        paths.push([...currentPath, current]);
        return;
      }
      
      if (visited.has(current)) return;
      visited.add(current);
      currentPath.push(current);
      
      for (const next of this.getDependents(current)) {
        dfs(next);
      }
      
      currentPath.pop();
      visited.delete(current);
    };
    
    if (this.graph.has(fromId) && this.graph.has(toId)) {
      dfs(fromId);
    }
    
    return paths;
  }
  
  // Get items that can be executed in parallel at a given state
  getReadyItems(completedItems: Set<string>, runningItems: Set<string>): string[] {
    const ready: string[] = [];
    
    for (const [itemId, _] of this.graph) {
      if (!completedItems.has(itemId) && 
          !runningItems.has(itemId) && 
          this.canExecute(itemId, completedItems)) {
        ready.push(itemId);
      }
    }
    
    return ready;
  }
}