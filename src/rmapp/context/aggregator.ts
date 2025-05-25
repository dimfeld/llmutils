import type { 
  Context, 
  ContextType, 
  AggregatedContext, 
  Pattern, 
  Example, 
  Insight,
  ContextSummary,
  RelationType
} from './types.js';
import { KnowledgeGraph as KnowledgeGraphClass } from './knowledge_graph.js';

export interface AggregatorOptions {
  maxRelationshipDepth?: number;
}

export class ContextAggregator {
  constructor(
    private scorer: any,
    private options: AggregatorOptions = {}
  ) {}
  
  aggregate(contexts: Context[]): AggregatedContext {
    // Group by type
    const byType = this.groupByType(contexts);
    
    // Extract key information
    const symbols = this.extractAllSymbols(contexts);
    const patterns = this.extractPatterns(contexts);
    const examples = this.extractExamples(contexts);
    
    // Build knowledge graph
    const graphInstance = this.buildKnowledgeGraph(contexts);
    const graph = graphInstance.toJSON();
    
    // Generate insights
    const insights = this.generateInsights(byType, graphInstance);
    
    // Generate summary
    const summary = this.generateSummary(contexts, byType, patterns);
    
    return {
      byType,
      symbols,
      patterns,
      examples,
      graph,
      insights,
      summary
    };
  }
  
  private groupByType(contexts: Context[]): Map<ContextType, Context[]> {
    const byType = new Map<ContextType, Context[]>();
    
    for (const context of contexts) {
      const existing = byType.get(context.type) || [];
      existing.push(context);
      byType.set(context.type, existing);
    }
    
    return byType;
  }
  
  private extractAllSymbols(contexts: Context[]): Set<string> {
    const symbols = new Set<string>();
    
    for (const context of contexts) {
      // Extract from metadata
      if (context.metadata.symbols) {
        context.metadata.symbols.forEach(s => symbols.add(s));
      }
      
      // Extract from code content
      if (context.type === 'code' && context.content.symbols) {
        context.content.symbols.forEach((s: string) => symbols.add(s));
      }
    }
    
    return symbols;
  }
  
  private extractPatterns(contexts: Context[]): Pattern[] {
    const patternMap = new Map<string, Pattern>();
    
    // Look for common patterns across contexts
    const codeContexts = contexts.filter(c => c.type === 'code');
    
    // Extract import patterns
    this.extractImportPatterns(codeContexts, patternMap);
    
    // Extract function patterns
    this.extractFunctionPatterns(codeContexts, patternMap);
    
    // Extract error handling patterns
    this.extractErrorPatterns(codeContexts, patternMap);
    
    // Extract testing patterns
    this.extractTestPatterns(codeContexts, patternMap);
    
    return Array.from(patternMap.values())
      .sort((a, b) => b.occurrences - a.occurrences);
  }
  
  private extractImportPatterns(
    contexts: Context[], 
    patternMap: Map<string, Pattern>
  ): void {
    for (const context of contexts) {
      const code = context.content.code || context.content;
      const codeStr = typeof code === 'string' ? code : JSON.stringify(code);
      
      // Look for import statements
      const importMatches = codeStr.matchAll(/import\s+(?:{[^}]+}|\w+)\s+from\s+['"]([^'"]+)['"]/g);
      
      for (const match of importMatches) {
        const module = match[1];
        const patternName = `import:${module}`;
        
        const existing = patternMap.get(patternName) || {
          name: patternName,
          description: `Import from ${module}`,
          occurrences: 0,
          contexts: [],
          confidence: 0.9
        };
        
        existing.occurrences++;
        existing.contexts.push(context.id);
        patternMap.set(patternName, existing);
      }
    }
  }
  
  private extractFunctionPatterns(
    contexts: Context[], 
    patternMap: Map<string, Pattern>
  ): void {
    const functionPatterns = [
      { regex: /async\s+function\s+\w+/, name: 'async-function', desc: 'Async function declaration' },
      { regex: /\w+\s*=\s*async\s*\([^)]*\)\s*=>/, name: 'async-arrow', desc: 'Async arrow function' },
      { regex: /\.then\s*\([^)]*\)\.catch\s*\(/, name: 'promise-chain', desc: 'Promise chain with error handling' },
      { regex: /try\s*{\s*[^}]+await/, name: 'try-await', desc: 'Try-catch with await' }
    ];
    
    for (const context of contexts) {
      const code = context.content.code || context.content;
      const codeStr = typeof code === 'string' ? code : JSON.stringify(code);
      
      for (const { regex, name, desc } of functionPatterns) {
        if (regex.test(codeStr)) {
          const existing = patternMap.get(name) || {
            name,
            description: desc,
            occurrences: 0,
            contexts: [],
            confidence: 0.8
          };
          
          existing.occurrences++;
          existing.contexts.push(context.id);
          patternMap.set(name, existing);
        }
      }
    }
  }
  
  private extractErrorPatterns(
    contexts: Context[], 
    patternMap: Map<string, Pattern>
  ): void {
    const errorPatterns = [
      { regex: /catch\s*\(\s*(?:error|e|err)\s*\)/, name: 'error-catch', desc: 'Error catching pattern' },
      { regex: /throw\s+new\s+\w*Error/, name: 'error-throw', desc: 'Error throwing pattern' },
      { regex: /console\.error/, name: 'error-log', desc: 'Error logging pattern' },
      { regex: /\.catch\s*\(\s*(?:error|err|e)\s*=>\s*{/, name: 'promise-catch', desc: 'Promise error handling' }
    ];
    
    for (const context of contexts) {
      const code = context.content.code || context.content;
      const codeStr = typeof code === 'string' ? code : JSON.stringify(code);
      
      for (const { regex, name, desc } of errorPatterns) {
        if (regex.test(codeStr)) {
          const existing = patternMap.get(name) || {
            name,
            description: desc,
            occurrences: 0,
            contexts: [],
            confidence: 0.85
          };
          
          existing.occurrences++;
          existing.contexts.push(context.id);
          patternMap.set(name, existing);
        }
      }
    }
  }
  
  private extractTestPatterns(
    contexts: Context[], 
    patternMap: Map<string, Pattern>
  ): void {
    const testPatterns = [
      { regex: /describe\s*\(['"]/, name: 'test-describe', desc: 'Test suite pattern' },
      { regex: /it\s*\(['"]/, name: 'test-it', desc: 'Test case pattern' },
      { regex: /expect\s*\(/, name: 'test-expect', desc: 'Assertion pattern' },
      { regex: /beforeEach\s*\(/, name: 'test-setup', desc: 'Test setup pattern' }
    ];
    
    for (const context of contexts) {
      const code = context.content.code || context.content;
      const codeStr = typeof code === 'string' ? code : JSON.stringify(code);
      
      for (const { regex, name, desc } of testPatterns) {
        if (regex.test(codeStr)) {
          const existing = patternMap.get(name) || {
            name,
            description: desc,
            occurrences: 0,
            contexts: [],
            confidence: 0.9
          };
          
          existing.occurrences++;
          existing.contexts.push(context.id);
          patternMap.set(name, existing);
        }
      }
    }
  }
  
  private extractExamples(contexts: Context[]): Example[] {
    const examples: Example[] = [];
    
    // Extract from documentation
    const docContexts = contexts.filter(c => c.type === 'documentation');
    
    for (const context of docContexts) {
      const content = context.content.content || '';
      
      // Look for code blocks in markdown
      const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
      let match;
      
      while ((match = codeBlockRegex.exec(content)) !== null) {
        const language = match[1] || 'text';
        const code = match[2].trim();
        
        // Find title (preceding heading)
        const beforeCode = content.substring(0, match.index);
        const titleMatch = beforeCode.match(/#{1,6}\s+([^\n]+)\n[^#]*$/);
        const title = titleMatch ? titleMatch[1] : 'Code Example';
        
        examples.push({
          title,
          code,
          explanation: this.extractExplanation(content, match.index),
          contextId: context.id,
          quality: this.assessExampleQuality(code, language)
        });
      }
    }
    
    // Sort by quality
    return examples.sort((a, b) => b.quality - a.quality);
  }
  
  private extractExplanation(content: string, codeIndex: number): string {
    // Look for text after the code block
    const afterCode = content.substring(codeIndex);
    const afterMatch = afterCode.match(/```[\s\S]*?```\s*\n([^#\n][^\n]*)/);
    
    if (afterMatch) {
      return afterMatch[1].trim();
    }
    
    // Look for text before the code block
    const beforeCode = content.substring(0, codeIndex);
    const lines = beforeCode.split('\n');
    
    // Find last non-empty, non-heading line
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line && !line.startsWith('#')) {
        return line;
      }
    }
    
    return '';
  }
  
  private assessExampleQuality(code: string, language: string): number {
    let quality = 0.5; // Base quality
    
    // Check length (not too short, not too long)
    const lines = code.split('\n').length;
    if (lines >= 5 && lines <= 50) quality += 0.2;
    
    // Check for comments
    if (/\/\/|\/\*|\#/.test(code)) quality += 0.1;
    
    // Check for proper language
    if (language !== 'text') quality += 0.1;
    
    // Check for imports/requires (complete example)
    if (/import|require/.test(code)) quality += 0.1;
    
    return Math.min(quality, 1);
  }
  
  private buildKnowledgeGraph(contexts: Context[]): KnowledgeGraphClass {
    const graph = new KnowledgeGraphClass();
    
    // Add nodes
    for (const context of contexts) {
      graph.addNode({
        id: context.id,
        type: context.type,
        label: this.getLabel(context),
        data: context
      });
    }
    
    // Add edges based on relationships
    for (let i = 0; i < contexts.length; i++) {
      for (let j = i + 1; j < contexts.length; j++) {
        const context1 = contexts[i];
        const context2 = contexts[j];
        
        const relationships = this.findRelationships(context1, context2);
        
        for (const rel of relationships) {
          graph.addEdge({
            from: context1.id,
            to: context2.id,
            type: rel.type,
            weight: rel.weight
          });
        }
      }
    }
    
    return graph;
  }
  
  private getLabel(context: Context): string {
    switch (context.type) {
      case 'code':
        return context.metadata.symbols?.[0] || 'Code';
      case 'documentation':
        return context.content.title || 'Documentation';
      case 'issue':
        return `Issue #${context.content.number}`;
      case 'pull_request':
        return `PR #${context.content.number}`;
      default:
        return context.type;
    }
  }
  
  private findRelationships(
    context1: Context, 
    context2: Context
  ): Array<{ type: RelationType; weight: number }> {
    const relationships: Array<{ type: RelationType; weight: number }> = [];
    
    // Check for file references
    if (this.hasFileReference(context1, context2)) {
      relationships.push({ type: 'references' as RelationType, weight: 0.8 });
    }
    
    // Check for symbol references
    const sharedSymbols = this.getSharedSymbols(context1, context2);
    if (sharedSymbols.length > 0) {
      relationships.push({ 
        type: 'references' as RelationType, 
        weight: Math.min(sharedSymbols.length * 0.2, 0.9) 
      });
    }
    
    // Check for testing relationship
    if (this.isTestFor(context1, context2)) {
      relationships.push({ type: 'tests' as RelationType, weight: 0.9 });
    }
    
    // Check for documentation relationship
    if (this.isDocumentationFor(context1, context2)) {
      relationships.push({ type: 'documents' as RelationType, weight: 0.85 });
    }
    
    // Check for similarity
    const similarity = this.calculateSimilarity(context1, context2);
    if (similarity > 0.6) {
      relationships.push({ type: 'similar' as RelationType, weight: similarity });
    }
    
    return relationships;
  }
  
  private hasFileReference(context1: Context, context2: Context): boolean {
    const content1 = JSON.stringify(context1.content);
    const content2 = JSON.stringify(context2.content);
    
    // Check if one references the other's file
    if (context1.source.type === 'file' && content2.includes(context1.source.location)) {
      return true;
    }
    if (context2.source.type === 'file' && content1.includes(context2.source.location)) {
      return true;
    }
    
    return false;
  }
  
  private getSharedSymbols(context1: Context, context2: Context): string[] {
    const symbols1 = new Set(context1.metadata.symbols || []);
    const symbols2 = new Set(context2.metadata.symbols || []);
    
    return Array.from(symbols1).filter(s => symbols2.has(s));
  }
  
  private isTestFor(test: Context, code: Context): boolean {
    if (test.type !== 'code' || code.type !== 'code') return false;
    
    const testFile = test.source.location;
    const codeFile = code.source.location;
    
    // Check if test file name matches code file
    if (testFile.includes('.test.') || testFile.includes('.spec.')) {
      const baseTestName = testFile.replace(/\.(test|spec)\./, '.');
      return baseTestName === codeFile;
    }
    
    return false;
  }
  
  private isDocumentationFor(doc: Context, code: Context): boolean {
    if (doc.type !== 'documentation') return false;
    
    // Check if documentation mentions code symbols
    const docContent = JSON.stringify(doc.content).toLowerCase();
    const codeSymbols = code.metadata.symbols || [];
    
    let matchCount = 0;
    for (const symbol of codeSymbols) {
      if (docContent.includes(symbol.toLowerCase())) {
        matchCount++;
      }
    }
    
    return codeSymbols.length > 0 && matchCount / codeSymbols.length > 0.5;
  }
  
  private calculateSimilarity(context1: Context, context2: Context): number {
    // Simple keyword-based similarity
    const keywords1 = new Set(context1.metadata.keywords || []);
    const keywords2 = new Set(context2.metadata.keywords || []);
    
    if (keywords1.size === 0 || keywords2.size === 0) return 0;
    
    const intersection = new Set([...keywords1].filter(k => keywords2.has(k)));
    const union = new Set([...keywords1, ...keywords2]);
    
    return intersection.size / union.size;
  }
  
  private generateInsights(
    byType: Map<ContextType, Context[]>,
    graph: KnowledgeGraphClass
  ): Insight[] {
    const insights: Insight[] = [];
    
    // Pattern insights
    const codeContexts = byType.get('code' as ContextType) || [];
    if (codeContexts.length > 0) {
      const commonPatterns = this.findCommonPatterns(codeContexts);
      if (commonPatterns.length > 0) {
        insights.push({
          type: 'pattern',
          title: 'Common Code Patterns',
          description: `Found ${commonPatterns.length} recurring patterns across ${codeContexts.length} code contexts`,
          importance: 0.8,
          data: commonPatterns
        });
      }
    }
    
    // Relationship insights
    const strongRelationships = graph.getStrongRelationships(0.8);
    if (strongRelationships.length > 0) {
      insights.push({
        type: 'relationship',
        title: 'Strong Relationships',
        description: 'Highly related contexts that should be considered together',
        importance: 0.9,
        data: strongRelationships.map(r => ({
          from: r.from.label,
          to: r.to.label,
          type: r.edge.type,
          weight: r.edge.weight
        }))
      });
    }
    
    // Coverage insights
    const coverage = this.analyzeCoverage(byType);
    insights.push({
      type: 'coverage',
      title: 'Context Coverage Analysis',
      description: this.describeCoverage(coverage),
      importance: 0.7,
      data: coverage
    });
    
    // Quality insights
    const qualityAnalysis = this.analyzeQuality(Array.from(byType.values()).flat());
    if (qualityAnalysis.lowQualityCount > 0) {
      insights.push({
        type: 'quality',
        title: 'Quality Concerns',
        description: `${qualityAnalysis.lowQualityCount} contexts have low quality scores`,
        importance: 0.6,
        data: qualityAnalysis
      });
    }
    
    // Central nodes insight
    const centralNodes = graph.getCentralNodes(5);
    if (centralNodes.length > 0) {
      insights.push({
        type: 'relationship',
        title: 'Key Contexts',
        description: 'Most connected and central contexts in the knowledge graph',
        importance: 0.85,
        data: centralNodes.map(n => ({
          label: n.label,
          type: n.type,
          connections: graph.getOutgoingEdges(n.id).length + graph.getIncomingEdges(n.id).length
        }))
      });
    }
    
    return insights.sort((a, b) => b.importance - a.importance);
  }
  
  private findCommonPatterns(contexts: Context[]): Pattern[] {
    const patterns = this.extractPatterns(contexts);
    return patterns.filter(p => p.occurrences >= 3);
  }
  
  private analyzeCoverage(byType: Map<ContextType, Context[]>): any {
    const totalContexts = Array.from(byType.values()).flat().length;
    
    return {
      total: totalContexts,
      byType: Object.fromEntries(
        Array.from(byType.entries()).map(([type, contexts]) => [
          type,
          {
            count: contexts.length,
            percentage: (contexts.length / totalContexts) * 100
          }
        ])
      ),
      hasCode: byType.has('code' as ContextType),
      hasDocs: byType.has('documentation' as ContextType),
      hasTests: this.hasTestContexts(byType.get('code' as ContextType) || []),
      balance: this.calculateBalance(byType)
    };
  }
  
  private hasTestContexts(codeContexts: Context[]): boolean {
    return codeContexts.some(c => 
      c.source.location.includes('.test.') || 
      c.source.location.includes('.spec.')
    );
  }
  
  private calculateBalance(byType: Map<ContextType, Context[]>): number {
    // Calculate how balanced the context types are
    const counts = Array.from(byType.values()).map(c => c.length);
    if (counts.length === 0) return 0;
    
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((sum, count) => sum + Math.pow(count - avg, 2), 0) / counts.length;
    
    // Convert to 0-1 scale where 1 is perfectly balanced
    return 1 / (1 + variance / avg);
  }
  
  private describeCoverage(coverage: any): string {
    const parts: string[] = [];
    
    if (!coverage.hasCode) {
      parts.push('Missing code contexts');
    }
    if (!coverage.hasDocs) {
      parts.push('Missing documentation contexts');
    }
    if (!coverage.hasTests) {
      parts.push('Missing test contexts');
    }
    
    if (coverage.balance < 0.5) {
      parts.push('Context types are imbalanced');
    }
    
    if (parts.length === 0) {
      return 'Good coverage across different context types';
    }
    
    return parts.join('; ');
  }
  
  private analyzeQuality(contexts: Context[]): any {
    const qualityScores = contexts.map(c => c.relevance);
    const lowQuality = contexts.filter(c => c.relevance < 0.5);
    
    return {
      averageScore: qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length,
      lowQualityCount: lowQuality.length,
      lowQualityContexts: lowQuality.map(c => ({
        id: c.id,
        type: c.type,
        score: c.relevance
      }))
    };
  }
  
  private generateSummary(
    contexts: Context[],
    byType: Map<ContextType, Context[]>,
    patterns: Pattern[]
  ): ContextSummary {
    // Calculate average relevance
    const totalRelevance = contexts.reduce((sum, c) => sum + c.relevance, 0);
    const averageRelevance = contexts.length > 0 ? totalRelevance / contexts.length : 0;
    
    // Extract key symbols
    const allSymbols = this.extractAllSymbols(contexts);
    const keySymbols = Array.from(allSymbols)
      .slice(0, 10); // Top 10 symbols
    
    // Extract key patterns
    const keyPatterns = patterns
      .slice(0, 5)
      .map(p => p.name);
    
    // Calculate coverage
    const coverage = this.calculateCoverageScore(byType);
    
    // Convert byType to Map<ContextType, number>
    const byTypeCount = new Map<ContextType, number>();
    for (const [type, ctxs] of byType) {
      byTypeCount.set(type, ctxs.length);
    }
    
    return {
      totalContexts: contexts.length,
      byType: byTypeCount,
      averageRelevance,
      keySymbols,
      keyPatterns,
      coverage
    };
  }
  
  private calculateCoverageScore(byType: Map<ContextType, Context[]>): number {
    // Score based on diversity and balance of context types
    const typeCount = byType.size;
    const maxTypes = 8; // Total number of context types
    
    const diversityScore = typeCount / maxTypes;
    const balanceScore = this.calculateBalance(byType);
    
    return (diversityScore + balanceScore) / 2;
  }
}