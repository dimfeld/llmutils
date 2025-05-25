import type {
  LearningEvent,
  Pattern,
  PatternType,
  EventType,
  Example,
  PatternSignature
} from './types.js';
import { createHash } from 'node:crypto';

export interface Detector {
  detect(events: LearningEvent[]): Promise<Pattern[]>;
}

interface NameExample {
  name: string;
  type: 'function' | 'class' | 'variable' | 'constant';
  context: string;
}

interface NamingConvention {
  pattern: string;
  type: string;
  examples: string[];
  recommendation: string;
}

export class PatternDetector {
  private detectors: Map<PatternType, Detector> = new Map();
  
  constructor() {
    this.registerDetectors();
  }
  
  async detectPatterns(
    events: LearningEvent[]
  ): Promise<Pattern[]> {
    const patterns: Pattern[] = [];
    
    // Run each detector
    for (const [type, detector] of this.detectors) {
      try {
        const detected = await detector.detect(events);
        patterns.push(...detected);
      } catch (error) {
        console.error(`Pattern detector ${type} failed:`, error);
      }
    }
    
    // Merge similar patterns
    const merged = this.mergePatterns(patterns);
    
    // Calculate confidence
    const withConfidence = merged.map(pattern => ({
      ...pattern,
      confidence: this.calculateConfidence(pattern)
    }));
    
    // Filter by minimum confidence
    return withConfidence.filter(p => p.confidence > 0.6);
  }
  
  private registerDetectors(): void {
    this.detectors.set(
      PatternType.CodeStyle,
      new CodeStyleDetector()
    );
    
    this.detectors.set(
      PatternType.ErrorHandling,
      new ErrorHandlingDetector()
    );
    
    this.detectors.set(
      PatternType.ReviewFeedback,
      new ReviewFeedbackDetector()
    );
    
    this.detectors.set(
      PatternType.ImplementationApproach,
      new ImplementationDetector()
    );
    
    this.detectors.set(
      PatternType.TestingStrategy,
      new TestingStrategyDetector()
    );
  }
  
  private mergePatterns(patterns: Pattern[]): Pattern[] {
    const merged: Pattern[] = [];
    const processed = new Set<string>();
    
    for (const pattern of patterns) {
      if (processed.has(pattern.id)) continue;
      
      // Find similar patterns
      const similar = patterns.filter(p =>
        p.id !== pattern.id &&
        !processed.has(p.id) &&
        this.areSimilar(pattern, p)
      );
      
      if (similar.length > 0) {
        // Merge into one pattern
        const mergedPattern = this.merge(pattern, ...similar);
        merged.push(mergedPattern);
        
        // Mark all as processed
        processed.add(pattern.id);
        similar.forEach(p => processed.add(p.id));
      } else {
        merged.push(pattern);
        processed.add(pattern.id);
      }
    }
    
    return merged;
  }
  
  private areSimilar(p1: Pattern, p2: Pattern): boolean {
    // Same type is required
    if (p1.type !== p2.type) return false;
    
    // Similar signatures
    const sig1 = JSON.stringify(p1.signature);
    const sig2 = JSON.stringify(p2.signature);
    
    // Simple similarity check
    const similarity = this.calculateStringSimilarity(sig1, sig2);
    return similarity > 0.8;
  }
  
  private calculateStringSimilarity(s1: string, s2: string): number {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    
    if (longer.length === 0) return 1.0;
    
    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }
  
  private levenshteinDistance(s1: string, s2: string): number {
    const matrix: number[][] = [];
    
    for (let i = 0; i <= s2.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= s1.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= s2.length; i++) {
      for (let j = 1; j <= s1.length; j++) {
        if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    return matrix[s2.length][s1.length];
  }
  
  private merge(first: Pattern, ...rest: Pattern[]): Pattern {
    const allPatterns = [first, ...rest];
    
    return {
      id: first.id,
      type: first.type,
      signature: this.mergeSignatures(allPatterns.map(p => p.signature)),
      occurrences: allPatterns.reduce((sum, p) => sum + p.occurrences, 0),
      confidence: 0, // Will be recalculated
      examples: this.mergeExamples(allPatterns.flatMap(p => p.examples)),
      recommendations: this.mergeRecommendations(
        allPatterns.flatMap(p => p.recommendations)
      ),
      lastSeen: new Date(
        Math.max(...allPatterns.map(p => p.lastSeen.getTime()))
      )
    };
  }
  
  private mergeSignatures(signatures: PatternSignature[]): PatternSignature {
    // Simple merge - take the most common features
    const featureCounts = new Map<string, Map<any, number>>();
    
    for (const sig of signatures) {
      for (const [key, value] of Object.entries(sig.features)) {
        if (!featureCounts.has(key)) {
          featureCounts.set(key, new Map());
        }
        const valueCounts = featureCounts.get(key)!;
        const valueStr = JSON.stringify(value);
        valueCounts.set(valueStr, (valueCounts.get(valueStr) || 0) + 1);
      }
    }
    
    // Take most common value for each feature
    const mergedFeatures: Record<string, any> = {};
    for (const [key, valueCounts] of featureCounts) {
      const mostCommon = Array.from(valueCounts.entries())
        .sort((a, b) => b[1] - a[1])[0];
      mergedFeatures[key] = JSON.parse(mostCommon[0]);
    }
    
    return {
      key: signatures[0].key,
      features: mergedFeatures,
      conditions: signatures[0].conditions
    };
  }
  
  private mergeExamples(examples: Example[]): Example[] {
    // Deduplicate and take top examples
    const seen = new Set<string>();
    const unique: Example[] = [];
    
    for (const example of examples) {
      const key = example.eventId || example.id;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(example);
      }
    }
    
    // Return top 10 examples
    return unique.slice(0, 10);
  }
  
  private mergeRecommendations(recommendations: string[]): string[] {
    // Deduplicate recommendations
    return Array.from(new Set(recommendations));
  }
  
  private calculateConfidence(pattern: Pattern): number {
    let confidence = 0;
    
    // Base confidence on occurrences
    if (pattern.occurrences >= 10) {
      confidence += 0.4;
    } else if (pattern.occurrences >= 5) {
      confidence += 0.3;
    } else if (pattern.occurrences >= 3) {
      confidence += 0.2;
    } else {
      confidence += 0.1;
    }
    
    // Boost for recent patterns
    const daysSinceLastSeen = 
      (Date.now() - pattern.lastSeen.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceLastSeen < 7) {
      confidence += 0.2;
    } else if (daysSinceLastSeen < 30) {
      confidence += 0.1;
    }
    
    // Boost for patterns with good examples
    if (pattern.examples.length >= 5) {
      confidence += 0.2;
    } else if (pattern.examples.length >= 3) {
      confidence += 0.1;
    }
    
    // Boost for actionable recommendations
    if (pattern.recommendations.length > 0) {
      confidence += 0.1;
    }
    
    return Math.min(confidence, 1.0);
  }
}

export class CodeStyleDetector implements Detector {
  async detect(events: LearningEvent[]): Promise<Pattern[]> {
    const codeEvents = events.filter(e => 
      e.type === EventType.CodeGeneration && e.context.generatedCode
    );
    
    if (codeEvents.length === 0) return [];
    
    const patterns: Pattern[] = [];
    
    // Detect naming patterns
    const namingPattern = this.detectNamingPattern(codeEvents);
    if (namingPattern) patterns.push(namingPattern);
    
    // Detect structure patterns
    const structurePattern = this.detectStructurePattern(codeEvents);
    if (structurePattern) patterns.push(structurePattern);
    
    // Detect import patterns
    const importPattern = this.detectImportPattern(codeEvents);
    if (importPattern) patterns.push(importPattern);
    
    return patterns;
  }
  
  private detectNamingPattern(events: LearningEvent[]): Pattern | null {
    const names: NameExample[] = [];
    
    for (const event of events) {
      if (event.context.generatedCode) {
        const extracted = this.extractNames(event.context.generatedCode);
        names.push(...extracted);
      }
    }
    
    if (names.length < 5) return null;
    
    // Analyze naming conventions
    const conventions = this.analyzeNamingConventions(names);
    
    if (conventions.length === 0) return null;
    
    return {
      id: this.generatePatternId('naming-convention'),
      type: PatternType.CodeStyle,
      signature: {
        key: 'naming-convention',
        features: {
          conventions: conventions.map(c => ({
            pattern: c.pattern,
            type: c.type
          }))
        }
      },
      occurrences: names.length,
      confidence: 0, // Will be calculated
      examples: names.slice(0, 10).map(n => ({
        id: this.generateId(),
        eventId: '',
        description: `${n.type} named "${n.name}"`,
        context: { name: n.name, type: n.type }
      })),
      recommendations: conventions.map(c => c.recommendation),
      lastSeen: new Date()
    };
  }
  
  private detectStructurePattern(events: LearningEvent[]): Pattern | null {
    const structures: any[] = [];
    
    for (const event of events) {
      if (event.context.generatedCode) {
        const structure = this.analyzeCodeStructure(event.context.generatedCode);
        if (structure) {
          structures.push(structure);
        }
      }
    }
    
    if (structures.length < 3) return null;
    
    // Find common patterns
    const commonPatterns = this.findCommonStructures(structures);
    
    if (commonPatterns.length === 0) return null;
    
    return {
      id: this.generatePatternId('code-structure'),
      type: PatternType.CodeStyle,
      signature: {
        key: 'code-structure',
        features: {
          patterns: commonPatterns
        }
      },
      occurrences: structures.length,
      confidence: 0,
      examples: structures.slice(0, 5).map(s => ({
        id: this.generateId(),
        eventId: '',
        description: 'Code structure pattern',
        context: s
      })),
      recommendations: [
        'Follow established code structure patterns',
        'Maintain consistent file organization'
      ],
      lastSeen: new Date()
    };
  }
  
  private detectImportPattern(events: LearningEvent[]): Pattern | null {
    const imports: string[][] = [];
    
    for (const event of events) {
      if (event.context.generatedCode) {
        const fileImports = this.extractImports(event.context.generatedCode);
        if (fileImports.length > 0) {
          imports.push(fileImports);
        }
      }
    }
    
    if (imports.length < 3) return null;
    
    // Analyze import order preferences
    const orderPattern = this.analyzeImportOrder(imports);
    
    if (!orderPattern) return null;
    
    return {
      id: this.generatePatternId('import-order'),
      type: PatternType.CodeStyle,
      signature: {
        key: 'import-order',
        features: {
          order: orderPattern
        }
      },
      occurrences: imports.length,
      confidence: 0,
      examples: imports.slice(0, 5).map(imp => ({
        id: this.generateId(),
        eventId: '',
        description: 'Import ordering example',
        code: imp.join('\n')
      })),
      recommendations: [
        `Use import order: ${orderPattern.join(' → ')}`
      ],
      lastSeen: new Date()
    };
  }
  
  private extractNames(code: string): NameExample[] {
    const names: NameExample[] = [];
    
    // Function names
    const funcMatches = code.matchAll(
      /(?:function|const|let|var)\s+(\w+)\s*[=\(]/g
    );
    for (const match of funcMatches) {
      names.push({
        name: match[1],
        type: 'function',
        context: match[0]
      });
    }
    
    // Class names
    const classMatches = code.matchAll(/class\s+(\w+)/g);
    for (const match of classMatches) {
      names.push({
        name: match[1],
        type: 'class',
        context: match[0]
      });
    }
    
    // Constants
    const constMatches = code.matchAll(/const\s+([A-Z_]+)\s*=/g);
    for (const match of constMatches) {
      names.push({
        name: match[1],
        type: 'constant',
        context: match[0]
      });
    }
    
    return names;
  }
  
  private analyzeNamingConventions(names: NameExample[]): NamingConvention[] {
    const conventions: NamingConvention[] = [];
    
    // Group by type
    const byType = new Map<string, NameExample[]>();
    for (const name of names) {
      const existing = byType.get(name.type) || [];
      existing.push(name);
      byType.set(name.type, existing);
    }
    
    // Analyze each type
    for (const [type, typeNames] of byType) {
      const pattern = this.detectNamingPattern(typeNames.map(n => n.name));
      if (pattern) {
        conventions.push({
          pattern,
          type,
          examples: typeNames.slice(0, 3).map(n => n.name),
          recommendation: `Use ${pattern} for ${type} names`
        });
      }
    }
    
    return conventions;
  }
  
  private detectNamingPattern(names: string[]): string | null {
    if (names.length === 0) return null;
    
    // Check for camelCase
    const camelCount = names.filter(n => /^[a-z][a-zA-Z0-9]*$/.test(n)).length;
    
    // Check for PascalCase
    const pascalCount = names.filter(n => /^[A-Z][a-zA-Z0-9]*$/.test(n)).length;
    
    // Check for snake_case
    const snakeCount = names.filter(n => /^[a-z][a-z0-9_]*$/.test(n)).length;
    
    // Check for UPPER_CASE
    const upperCount = names.filter(n => /^[A-Z][A-Z0-9_]*$/.test(n)).length;
    
    const total = names.length;
    
    if (camelCount / total > 0.7) return 'camelCase';
    if (pascalCount / total > 0.7) return 'PascalCase';
    if (snakeCount / total > 0.7) return 'snake_case';
    if (upperCount / total > 0.7) return 'UPPER_CASE';
    
    return null;
  }
  
  private analyzeCodeStructure(code: string): any {
    // Simple structure analysis
    const lines = code.split('\n');
    const structure = {
      imports: 0,
      exports: 0,
      functions: 0,
      classes: 0,
      interfaces: 0,
      types: 0,
      hasDefaultExport: false,
      hasNamedExports: false
    };
    
    for (const line of lines) {
      if (line.match(/^import\s/)) structure.imports++;
      if (line.match(/^export\s/)) structure.exports++;
      if (line.match(/function\s+\w+/)) structure.functions++;
      if (line.match(/class\s+\w+/)) structure.classes++;
      if (line.match(/interface\s+\w+/)) structure.interfaces++;
      if (line.match(/type\s+\w+\s*=/)) structure.types++;
      if (line.match(/export\s+default/)) structure.hasDefaultExport = true;
      if (line.match(/export\s+{/)) structure.hasNamedExports = true;
    }
    
    return structure;
  }
  
  private findCommonStructures(structures: any[]): any[] {
    // Find patterns that appear in at least 60% of structures
    const threshold = structures.length * 0.6;
    const patterns: any[] = [];
    
    // Check for consistent export patterns
    const defaultExportCount = structures.filter(s => s.hasDefaultExport).length;
    if (defaultExportCount >= threshold) {
      patterns.push({ type: 'export', pattern: 'default' });
    }
    
    const namedExportCount = structures.filter(s => s.hasNamedExports).length;
    if (namedExportCount >= threshold) {
      patterns.push({ type: 'export', pattern: 'named' });
    }
    
    return patterns;
  }
  
  private extractImports(code: string): string[] {
    const imports: string[] = [];
    const importRegex = /^import\s+.+$/gm;
    
    const matches = code.match(importRegex);
    if (matches) {
      imports.push(...matches);
    }
    
    return imports;
  }
  
  private analyzeImportOrder(importsList: string[][]): string[] | null {
    // Categorize imports
    const categories = {
      builtin: 'Node.js built-ins',
      external: 'External packages',
      internal: 'Internal modules',
      relative: 'Relative imports',
      type: 'Type imports'
    };
    
    // Analyze order in each file
    const orders: string[][] = [];
    
    for (const imports of importsList) {
      const order: string[] = [];
      let lastCategory = '';
      
      for (const imp of imports) {
        const category = this.categorizeImport(imp);
        if (category !== lastCategory) {
          order.push(category);
          lastCategory = category;
        }
      }
      
      orders.push(order);
    }
    
    // Find most common order
    const orderCounts = new Map<string, number>();
    for (const order of orders) {
      const key = order.join(',');
      orderCounts.set(key, (orderCounts.get(key) || 0) + 1);
    }
    
    const mostCommon = Array.from(orderCounts.entries())
      .sort((a, b) => b[1] - a[1])[0];
    
    if (!mostCommon || mostCommon[1] < importsList.length * 0.6) {
      return null;
    }
    
    return mostCommon[0].split(',').map(cat => categories[cat as keyof typeof categories]);
  }
  
  private categorizeImport(importLine: string): string {
    if (importLine.includes('import type')) return 'type';
    if (importLine.match(/from ['"]node:/)) return 'builtin';
    if (importLine.match(/from ['"][^.]/)) return 'external';
    if (importLine.match(/from ['"]@\//)) return 'internal';
    if (importLine.match(/from ['"][.]/)) return 'relative';
    return 'unknown';
  }
  
  private generatePatternId(type: string): string {
    return createHash('sha256')
      .update(type + Date.now())
      .digest('hex')
      .substring(0, 16);
  }
  
  private generateId(): string {
    return Math.random().toString(36).substring(2, 9);
  }
}

export class ErrorHandlingDetector implements Detector {
  async detect(events: LearningEvent[]): Promise<Pattern[]> {
    const errorEvents = events.filter(e => 
      e.type === EventType.ErrorRecovery
    );
    
    if (errorEvents.length < 3) return [];
    
    const patterns: Pattern[] = [];
    
    // Group by error type
    const byErrorType = this.groupByErrorType(errorEvents);
    
    for (const [errorType, typeEvents] of byErrorType) {
      if (typeEvents.length >= 3) {
        const pattern = this.createErrorPattern(errorType, typeEvents);
        if (pattern) {
          patterns.push(pattern);
        }
      }
    }
    
    return patterns;
  }
  
  private groupByErrorType(events: LearningEvent[]): Map<string, LearningEvent[]> {
    const grouped = new Map<string, LearningEvent[]>();
    
    for (const event of events) {
      const errorType = event.context.error?.type || 'unknown';
      const existing = grouped.get(errorType) || [];
      existing.push(event);
      grouped.set(errorType, existing);
    }
    
    return grouped;
  }
  
  private createErrorPattern(
    errorType: string,
    events: LearningEvent[]
  ): Pattern | null {
    // Find successful recoveries
    const successful = events.filter(e => e.outcome.success);
    
    if (successful.length === 0) return null;
    
    // Extract recovery strategies
    const strategies = this.extractRecoveryStrategies(successful);
    
    return {
      id: this.generatePatternId(`error-${errorType}`),
      type: PatternType.ErrorHandling,
      signature: {
        key: `error-recovery-${errorType}`,
        features: {
          errorType,
          strategies,
          successRate: successful.length / events.length
        }
      },
      occurrences: events.length,
      confidence: 0,
      examples: successful.slice(0, 5).map(e => ({
        id: this.generateId(),
        eventId: e.id,
        description: `Recovered from ${errorType}`,
        context: {
          error: e.context.error,
          recovery: e.action.parameters
        }
      })),
      recommendations: strategies.map(s => 
        `When encountering ${errorType}, try: ${s.description}`
      ),
      lastSeen: new Date(
        Math.max(...events.map(e => e.timestamp.getTime()))
      )
    };
  }
  
  private extractRecoveryStrategies(events: LearningEvent[]): any[] {
    const strategies: any[] = [];
    
    for (const event of events) {
      const strategy = {
        type: event.action.type,
        description: this.describeStrategy(event.action),
        successCount: 1
      };
      
      // Group similar strategies
      const existing = strategies.find(s => 
        s.type === strategy.type &&
        s.description === strategy.description
      );
      
      if (existing) {
        existing.successCount++;
      } else {
        strategies.push(strategy);
      }
    }
    
    // Sort by success count
    return strategies.sort((a, b) => b.successCount - a.successCount);
  }
  
  private describeStrategy(action: any): string {
    switch (action.type) {
      case 'retry':
        return 'Retry the operation';
      case 'alternative':
        return 'Try an alternative approach';
      case 'fix':
        return 'Apply a specific fix';
      default:
        return 'Custom recovery strategy';
    }
  }
  
  private generatePatternId(type: string): string {
    return createHash('sha256')
      .update(type + Date.now())
      .digest('hex')
      .substring(0, 16);
  }
  
  private generateId(): string {
    return Math.random().toString(36).substring(2, 9);
  }
}

export class ReviewFeedbackDetector implements Detector {
  async detect(events: LearningEvent[]): Promise<Pattern[]> {
    const reviewEvents = events.filter(e => 
      e.type === EventType.ReviewResponse ||
      (e.type === EventType.UserFeedback && e.context.review)
    );
    
    if (reviewEvents.length < 5) return [];
    
    const patterns: Pattern[] = [];
    
    // Detect response time patterns
    const responsePattern = this.detectResponseTimePattern(reviewEvents);
    if (responsePattern) patterns.push(responsePattern);
    
    // Detect comment resolution patterns
    const resolutionPattern = this.detectResolutionPattern(reviewEvents);
    if (resolutionPattern) patterns.push(resolutionPattern);
    
    return patterns;
  }
  
  private detectResponseTimePattern(events: LearningEvent[]): Pattern | null {
    const responseTimes = events
      .filter(e => e.outcome.duration)
      .map(e => e.outcome.duration);
    
    if (responseTimes.length < 3) return null;
    
    const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    const median = this.calculateMedian(responseTimes);
    
    return {
      id: this.generatePatternId('response-time'),
      type: PatternType.ReviewFeedback,
      signature: {
        key: 'review-response-time',
        features: {
          averageTime: avg,
          medianTime: median,
          unit: 'milliseconds'
        }
      },
      occurrences: responseTimes.length,
      confidence: 0,
      examples: [],
      recommendations: [
        `Aim to respond to reviews within ${Math.round(median / 1000)} seconds`
      ],
      lastSeen: new Date()
    };
  }
  
  private detectResolutionPattern(events: LearningEvent[]): Pattern | null {
    const resolutions = events.filter(e => 
      e.outcome.success &&
      e.outcome.metrics?.reviewsResolved
    );
    
    if (resolutions.length < 3) return null;
    
    // Analyze resolution strategies
    const strategies = this.analyzeResolutionStrategies(resolutions);
    
    return {
      id: this.generatePatternId('review-resolution'),
      type: PatternType.ReviewFeedback,
      signature: {
        key: 'review-resolution-strategy',
        features: {
          strategies,
          successRate: resolutions.length / events.length
        }
      },
      occurrences: resolutions.length,
      confidence: 0,
      examples: resolutions.slice(0, 5).map(e => ({
        id: this.generateId(),
        eventId: e.id,
        description: 'Successful review resolution',
        context: e.context
      })),
      recommendations: strategies.map(s => s.recommendation),
      lastSeen: new Date()
    };
  }
  
  private analyzeResolutionStrategies(events: LearningEvent[]): any[] {
    // Simplified strategy analysis
    return [{
      type: 'immediate-fix',
      count: events.length,
      recommendation: 'Address review comments immediately with fixes'
    }];
  }
  
  private calculateMedian(numbers: number[]): number {
    const sorted = numbers.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    
    return sorted[mid];
  }
  
  private generatePatternId(type: string): string {
    return createHash('sha256')
      .update(type + Date.now())
      .digest('hex')
      .substring(0, 16);
  }
  
  private generateId(): string {
    return Math.random().toString(36).substring(2, 9);
  }
}

export class ImplementationDetector implements Detector {
  async detect(events: LearningEvent[]): Promise<Pattern[]> {
    const implEvents = events.filter(e => 
      e.type === EventType.IssueImplementation
    );
    
    if (implEvents.length < 3) return [];
    
    const patterns: Pattern[] = [];
    
    // Detect file organization patterns
    const orgPattern = this.detectOrganizationPattern(implEvents);
    if (orgPattern) patterns.push(orgPattern);
    
    // Detect implementation approach patterns
    const approachPattern = this.detectApproachPattern(implEvents);
    if (approachPattern) patterns.push(approachPattern);
    
    return patterns;
  }
  
  private detectOrganizationPattern(events: LearningEvent[]): Pattern | null {
    const filePatterns: any[] = [];
    
    for (const event of events) {
      if (event.context.fileChanges) {
        const pattern = this.analyzeFileOrganization(event.context.fileChanges);
        if (pattern) {
          filePatterns.push(pattern);
        }
      }
    }
    
    if (filePatterns.length < 3) return null;
    
    return {
      id: this.generatePatternId('file-organization'),
      type: PatternType.ImplementationApproach,
      signature: {
        key: 'file-organization',
        features: {
          patterns: filePatterns
        }
      },
      occurrences: filePatterns.length,
      confidence: 0,
      examples: filePatterns.slice(0, 5).map(p => ({
        id: this.generateId(),
        eventId: '',
        description: 'File organization pattern',
        context: p
      })),
      recommendations: [
        'Maintain consistent file organization',
        'Group related files together'
      ],
      lastSeen: new Date()
    };
  }
  
  private detectApproachPattern(events: LearningEvent[]): Pattern | null {
    const successful = events.filter(e => e.outcome.success);
    
    if (successful.length < 3) return null;
    
    // Analyze implementation approaches
    const approaches = this.analyzeApproaches(successful);
    
    return {
      id: this.generatePatternId('implementation-approach'),
      type: PatternType.ImplementationApproach,
      signature: {
        key: 'implementation-strategy',
        features: {
          approaches,
          successRate: successful.length / events.length
        }
      },
      occurrences: successful.length,
      confidence: 0,
      examples: successful.slice(0, 5).map(e => ({
        id: this.generateId(),
        eventId: e.id,
        description: 'Successful implementation',
        context: {
          action: e.action,
          outcome: e.outcome
        }
      })),
      recommendations: approaches.map(a => a.recommendation),
      lastSeen: new Date()
    };
  }
  
  private analyzeFileOrganization(changes: any[]): any {
    // Analyze file structure
    const directories = new Set<string>();
    const fileTypes = new Set<string>();
    
    for (const change of changes) {
      const parts = change.file.split('/');
      if (parts.length > 1) {
        directories.add(parts[0]);
      }
      
      const ext = change.file.split('.').pop();
      if (ext) {
        fileTypes.add(ext);
      }
    }
    
    return {
      directories: Array.from(directories),
      fileTypes: Array.from(fileTypes),
      fileCount: changes.length
    };
  }
  
  private analyzeApproaches(events: LearningEvent[]): any[] {
    return [{
      type: 'incremental',
      count: events.length,
      recommendation: 'Build features incrementally with frequent testing'
    }];
  }
  
  private generatePatternId(type: string): string {
    return createHash('sha256')
      .update(type + Date.now())
      .digest('hex')
      .substring(0, 16);
  }
  
  private generateId(): string {
    return Math.random().toString(36).substring(2, 9);
  }
}

export class TestingStrategyDetector implements Detector {
  async detect(events: LearningEvent[]): Promise<Pattern[]> {
    const testEvents = events.filter(e => 
      e.type === EventType.TestExecution ||
      (e.context.fileChanges && 
       e.context.fileChanges.some((f: any) => f.file.includes('.test.')))
    );
    
    if (testEvents.length < 3) return [];
    
    const patterns: Pattern[] = [];
    
    // Detect test coverage patterns
    const coveragePattern = this.detectCoveragePattern(testEvents);
    if (coveragePattern) patterns.push(coveragePattern);
    
    // Detect test organization patterns
    const orgPattern = this.detectTestOrganizationPattern(testEvents);
    if (orgPattern) patterns.push(orgPattern);
    
    return patterns;
  }
  
  private detectCoveragePattern(events: LearningEvent[]): Pattern | null {
    const withMetrics = events.filter(e => 
      e.outcome.metrics?.testsAdded !== undefined
    );
    
    if (withMetrics.length < 3) return null;
    
    const avgTestsAdded = withMetrics.reduce(
      (sum, e) => sum + (e.outcome.metrics?.testsAdded || 0), 0
    ) / withMetrics.length;
    
    return {
      id: this.generatePatternId('test-coverage'),
      type: PatternType.TestingStrategy,
      signature: {
        key: 'test-coverage-pattern',
        features: {
          averageTestsPerChange: avgTestsAdded,
          consistency: this.calculateConsistency(withMetrics)
        }
      },
      occurrences: withMetrics.length,
      confidence: 0,
      examples: [],
      recommendations: [
        `Add approximately ${Math.round(avgTestsAdded)} tests per feature`
      ],
      lastSeen: new Date()
    };
  }
  
  private detectTestOrganizationPattern(events: LearningEvent[]): Pattern | null {
    const testFiles: string[] = [];
    
    for (const event of events) {
      if (event.context.fileChanges) {
        const tests = event.context.fileChanges
          .filter((f: any) => f.file.includes('.test.'))
          .map((f: any) => f.file);
        testFiles.push(...tests);
      }
    }
    
    if (testFiles.length < 3) return null;
    
    const pattern = this.analyzeTestFilePattern(testFiles);
    
    return {
      id: this.generatePatternId('test-organization'),
      type: PatternType.TestingStrategy,
      signature: {
        key: 'test-file-organization',
        features: pattern
      },
      occurrences: testFiles.length,
      confidence: 0,
      examples: testFiles.slice(0, 5).map(f => ({
        id: this.generateId(),
        eventId: '',
        description: 'Test file',
        context: { file: f }
      })),
      recommendations: [
        'Keep test files next to source files',
        'Use consistent test file naming'
      ],
      lastSeen: new Date()
    };
  }
  
  private calculateConsistency(events: LearningEvent[]): number {
    const values = events.map(e => e.outcome.metrics?.testsAdded || 0);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    
    const variance = values.reduce((sum, val) => {
      return sum + Math.pow(val - mean, 2);
    }, 0) / values.length;
    
    const stdDev = Math.sqrt(variance);
    
    // Lower std dev means more consistency
    return 1 / (1 + stdDev);
  }
  
  private analyzeTestFilePattern(files: string[]): any {
    const patterns = {
      colocated: 0,
      separateDir: 0,
      naming: new Map<string, number>()
    };
    
    for (const file of files) {
      // Check if test is next to source
      if (file.includes('/__tests__/') || file.includes('/tests/')) {
        patterns.separateDir++;
      } else {
        patterns.colocated++;
      }
      
      // Check naming pattern
      if (file.endsWith('.test.ts')) {
        patterns.naming.set('.test.ts', (patterns.naming.get('.test.ts') || 0) + 1);
      } else if (file.endsWith('.spec.ts')) {
        patterns.naming.set('.spec.ts', (patterns.naming.get('.spec.ts') || 0) + 1);
      }
    }
    
    return patterns;
  }
  
  private generatePatternId(type: string): string {
    return createHash('sha256')
      .update(type + Date.now())
      .digest('hex')
      .substring(0, 16);
  }
  
  private generateId(): string {
    return Math.random().toString(36).substring(2, 9);
  }
}