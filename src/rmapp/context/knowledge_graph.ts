import type { 
  KnowledgeNode, 
  KnowledgeEdge, 
  RelationType 
} from './types.js';

export class KnowledgeGraph {
  private _nodes: Map<string, KnowledgeNode> = new Map();
  private _edges: Map<string, KnowledgeEdge[]> = new Map();
  private reverseEdges: Map<string, KnowledgeEdge[]> = new Map();
  
  get nodes(): KnowledgeNode[] {
    return Array.from(this._nodes.values());
  }
  
  get edges(): KnowledgeEdge[] {
    return Array.from(this._edges.values()).flat();
  }
  
  addNode(node: KnowledgeNode): void {
    this._nodes.set(node.id, node);
    
    // Initialize edge lists
    if (!this._edges.has(node.id)) {
      this._edges.set(node.id, []);
    }
    if (!this.reverseEdges.has(node.id)) {
      this.reverseEdges.set(node.id, []);
    }
  }
  
  addEdge(edge: KnowledgeEdge): void {
    // Add to forward edges
    const fromEdges = this._edges.get(edge.from) || [];
    fromEdges.push(edge);
    this._edges.set(edge.from, fromEdges);
    
    // Add to reverse edges
    const toEdges = this.reverseEdges.get(edge.to) || [];
    toEdges.push(edge);
    this.reverseEdges.set(edge.to, toEdges);
  }
  
  getNode(id: string): KnowledgeNode | undefined {
    return this._nodes.get(id);
  }
  
  getOutgoingEdges(nodeId: string): KnowledgeEdge[] {
    return this._edges.get(nodeId) || [];
  }
  
  getIncomingEdges(nodeId: string): KnowledgeEdge[] {
    return this.reverseEdges.get(nodeId) || [];
  }
  
  getRelatedNodes(nodeId: string, relationTypes?: RelationType[]): KnowledgeNode[] {
    const edges = this.getOutgoingEdges(nodeId);
    const relatedNodes: KnowledgeNode[] = [];
    
    for (const edge of edges) {
      if (!relationTypes || relationTypes.includes(edge.type)) {
        const node = this._nodes.get(edge.to);
        if (node) {
          relatedNodes.push(node);
        }
      }
    }
    
    return relatedNodes;
  }
  
  getStrongRelationships(minWeight: number = 0.8): Array<{
    from: KnowledgeNode;
    to: KnowledgeNode;
    edge: KnowledgeEdge;
  }> {
    const relationships: Array<{
      from: KnowledgeNode;
      to: KnowledgeNode;
      edge: KnowledgeEdge;
    }> = [];
    
    for (const [nodeId, edges] of this._edges) {
      const fromNode = this._nodes.get(nodeId);
      if (!fromNode) continue;
      
      for (const edge of edges) {
        if (edge.weight >= minWeight) {
          const toNode = this._nodes.get(edge.to);
          if (toNode) {
            relationships.push({
              from: fromNode,
              to: toNode,
              edge
            });
          }
        }
      }
    }
    
    return relationships;
  }
  
  findPath(fromId: string, toId: string): KnowledgeNode[] | null {
    const visited = new Set<string>();
    const queue: Array<{ nodeId: string; path: string[] }> = [
      { nodeId: fromId, path: [fromId] }
    ];
    
    while (queue.length > 0) {
      const { nodeId, path } = queue.shift()!;
      
      if (nodeId === toId) {
        return path.map(id => this._nodes.get(id)!).filter(Boolean);
      }
      
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      
      const edges = this.getOutgoingEdges(nodeId);
      for (const edge of edges) {
        if (!visited.has(edge.to)) {
          queue.push({
            nodeId: edge.to,
            path: [...path, edge.to]
          });
        }
      }
    }
    
    return null;
  }
  
  getClusters(): Map<string, Set<string>> {
    const clusters = new Map<string, Set<string>>();
    const visited = new Set<string>();
    let clusterId = 0;
    
    // Find connected components
    for (const nodeId of this._nodes.keys()) {
      if (!visited.has(nodeId)) {
        const cluster = new Set<string>();
        this.dfs(nodeId, visited, cluster);
        clusters.set(`cluster_${clusterId++}`, cluster);
      }
    }
    
    return clusters;
  }
  
  private dfs(nodeId: string, visited: Set<string>, cluster: Set<string>): void {
    if (visited.has(nodeId)) return;
    
    visited.add(nodeId);
    cluster.add(nodeId);
    
    // Visit all connected nodes (both directions)
    const outgoing = this.getOutgoingEdges(nodeId);
    const incoming = this.getIncomingEdges(nodeId);
    
    for (const edge of [...outgoing, ...incoming]) {
      const neighborId = edge.from === nodeId ? edge.to : edge.from;
      this.dfs(neighborId, visited, cluster);
    }
  }
  
  getCentralNodes(topN: number = 10): KnowledgeNode[] {
    const centrality = new Map<string, number>();
    
    // Calculate degree centrality
    for (const nodeId of this._nodes.keys()) {
      const inDegree = this.getIncomingEdges(nodeId).length;
      const outDegree = this.getOutgoingEdges(nodeId).length;
      centrality.set(nodeId, inDegree + outDegree);
    }
    
    // Sort by centrality
    const sorted = Array.from(centrality.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN);
    
    return sorted
      .map(([nodeId]) => this._nodes.get(nodeId))
      .filter(Boolean) as KnowledgeNode[];
  }
  
  toJSON(): { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] } {
    return {
      nodes: this.nodes,
      edges: this.edges
    };
  }
}