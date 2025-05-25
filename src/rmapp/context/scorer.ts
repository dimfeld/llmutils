import type { Context, ContextQuery, Pattern } from './types.js';
import { ContextType } from './types.js';

export interface Scorer {
  calculateQualityScore(context: Context): number;
  calculateRelevanceScore(context: Context, query: ContextQuery): number;
}

export class ContextScorer {
  private scorers: Map<ContextType, Scorer> = new Map();
  
  constructor() {
    this.registerScorers();
  }
  
  score(context: Context, query: ContextQuery): number {
    // Update context relevance
    const score = this.scoreContext(context, query);
    context.relevance = score;
    return score;
  }
  
  scoreContext(context: Context, query: ContextQuery): number {
    const scorer = this.scorers.get(context.type);
    if (!scorer) return 0;
    
    // Calculate component scores
    const keywordScore = this.calculateKeywordScore(context, query);
    const freshnessScore = this.calculateFreshnessScore(context);
    const qualityScore = scorer.calculateQualityScore(context);
    const relevanceScore = scorer.calculateRelevanceScore(context, query);
    const typeScore = this.calculateTypeScore(context, query);
    
    // Weighted combination
    return (
      keywordScore * 0.25 +
      freshnessScore * 0.1 +
      qualityScore * 0.2 +
      relevanceScore * 0.35 +
      typeScore * 0.1
    );
  }
  
  private registerScorers(): void {
    this.scorers.set(ContextType.Code, new CodeScorer());
    this.scorers.set(ContextType.Documentation, new DocumentationScorer());
    this.scorers.set(ContextType.Issue, new IssueScorer());
    this.scorers.set(ContextType.PullRequest, new PRScorer());
    this.scorers.set(ContextType.Commit, new CommitScorer());
  }
  
  private calculateKeywordScore(
    context: Context,
    query: ContextQuery
  ): number {
    const content = JSON.stringify(context.content).toLowerCase();
    const keywords = query.keywords.map(k => k.toLowerCase());
    
    let score = 0;
    let totalWeight = 0;
    
    for (let i = 0; i < keywords.length; i++) {
      const keyword = keywords[i];
      const weight = 1 / (i + 1); // Higher weight for earlier keywords
      
      // Count occurrences
      const occurrences = (content.match(new RegExp(keyword, 'g')) || []).length;
      
      if (occurrences > 0) {
        // Logarithmic scaling to avoid over-weighting high occurrences
        score += weight * Math.log(occurrences + 1) / Math.log(10);
      }
      
      // Check metadata
      const metadataStr = JSON.stringify(context.metadata).toLowerCase();
      if (metadataStr.includes(keyword)) {
        score += weight * 0.5;
      }
      
      totalWeight += weight;
    }
    
    return totalWeight > 0 ? score / totalWeight : 0;
  }
  
  private calculateFreshnessScore(context: Context): number {
    const age = Date.now() - context.timestamp.getTime();
    const dayInMs = 24 * 60 * 60 * 1000;
    
    // Use last modified if available
    if (context.metadata.lastModified) {
      const modifiedAge = Date.now() - new Date(context.metadata.lastModified).getTime();
      // Exponential decay with 30-day half-life
      return Math.exp(-modifiedAge / (30 * dayInMs));
    }
    
    // Exponential decay
    return Math.exp(-age / (30 * dayInMs));
  }
  
  private calculateTypeScore(context: Context, query: ContextQuery): number {
    if (!query.types || query.types.length === 0) {
      return 1; // No type preference
    }
    
    return query.types.includes(context.type) ? 1 : 0.5;
  }
}

class CodeScorer implements Scorer {
  calculateQualityScore(context: Context): number {
    const code = context.content.code || context.content;
    const codeStr = typeof code === 'string' ? code : JSON.stringify(code);
    
    // Check for quality indicators
    const hasTests = /test|spec|\.test\.|\.spec\./.test(codeStr);
    const hasComments = this.calculateCommentRatio(codeStr) > 0.1;
    const hasTypes = /:\s*\w+|interface|type\s+\w+/.test(codeStr);
    const isWellFormatted = this.checkFormatting(codeStr);
    const hasErrorHandling = /try|catch|throw|error/i.test(codeStr);
    
    let score = 0;
    if (hasTests) score += 0.2;
    if (hasComments) score += 0.2;
    if (hasTypes) score += 0.2;
    if (isWellFormatted) score += 0.2;
    if (hasErrorHandling) score += 0.2;
    
    return score;
  }
  
  calculateRelevanceScore(
    context: Context,
    query: ContextQuery
  ): number {
    // Check if context contains relevant patterns
    const patterns = this.extractPatterns(context);
    const queryPatterns = this.inferPatterns(query);
    
    const similarity = this.calculatePatternSimilarity(patterns, queryPatterns);
    
    // Boost score for exact symbol matches
    const symbols = context.metadata.symbols || [];
    const keywordBoost = query.keywords.some(keyword => 
      symbols.some(symbol => symbol.toLowerCase() === keyword.toLowerCase())
    ) ? 0.3 : 0;
    
    return Math.min(similarity + keywordBoost, 1);
  }
  
  private calculateCommentRatio(code: string): number {
    const lines = code.split('\n');
    const commentLines = lines.filter(line => {
      const trimmed = line.trim();
      return trimmed.startsWith('//') || 
             trimmed.startsWith('/*') || 
             trimmed.startsWith('*') ||
             trimmed.startsWith('#');
    });
    
    return lines.length > 0 ? commentLines.length / lines.length : 0;
  }
  
  private checkFormatting(code: string): boolean {
    const lines = code.split('\n');
    
    // Check for consistent indentation
    const indents = lines
      .filter(line => line.trim().length > 0)
      .map(line => line.match(/^(\s*)/)?.[1].length || 0);
    
    if (indents.length === 0) return true;
    
    // Check if indents are multiples of 2 or 4
    const baseIndent = Math.min(...indents.filter(i => i > 0));
    const consistentIndents = indents.every(indent => 
      indent === 0 || indent % baseIndent === 0
    );
    
    return consistentIndents;
  }
  
  private extractPatterns(context: Context): string[] {
    const patterns: string[] = [];
    const code = context.content.code || context.content;
    const codeStr = typeof code === 'string' ? code : JSON.stringify(code);
    
    // Extract common patterns
    if (/async\s+\w+|\.then\(|await\s+/.test(codeStr)) patterns.push('async');
    if (/class\s+\w+/.test(codeStr)) patterns.push('class');
    if (/function\s+\w+|\w+\s*=\s*\(/.test(codeStr)) patterns.push('function');
    if (/import\s+|require\(/.test(codeStr)) patterns.push('module');
    if (/export\s+/.test(codeStr)) patterns.push('export');
    if (/\.(get|post|put|delete|patch)\(/.test(codeStr)) patterns.push('api');
    if (/useState|useEffect|React/.test(codeStr)) patterns.push('react');
    
    return patterns;
  }
  
  private inferPatterns(query: ContextQuery): string[] {
    const patterns: string[] = [];
    const keywords = query.keywords.join(' ').toLowerCase();
    
    // Infer patterns from keywords
    if (/async|await|promise/.test(keywords)) patterns.push('async');
    if (/class|object|oop/.test(keywords)) patterns.push('class');
    if (/function|method/.test(keywords)) patterns.push('function');
    if (/import|export|module/.test(keywords)) patterns.push('module');
    if (/api|endpoint|request/.test(keywords)) patterns.push('api');
    if (/react|component|hook/.test(keywords)) patterns.push('react');
    
    return patterns;
  }
  
  private calculatePatternSimilarity(patterns1: string[], patterns2: string[]): number {
    if (patterns1.length === 0 || patterns2.length === 0) return 0.5;
    
    const set1 = new Set(patterns1);
    const set2 = new Set(patterns2);
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return intersection.size / union.size;
  }
}

class DocumentationScorer implements Scorer {
  calculateQualityScore(context: Context): number {
    const content = context.content.content || context.content;
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
    
    // Check for quality indicators
    const hasHeadings = /^#{1,6}\s+.+$/m.test(contentStr);
    const hasCodeExamples = /```[\s\S]*?```/.test(contentStr);
    const hasLinks = /\[.+\]\(.+\)/.test(contentStr);
    const hasLists = /^\s*[-*+]\s+.+$/m.test(contentStr);
    const length = contentStr.length;
    
    let score = 0;
    if (hasHeadings) score += 0.25;
    if (hasCodeExamples) score += 0.25;
    if (hasLinks) score += 0.15;
    if (hasLists) score += 0.15;
    if (length > 500) score += 0.2; // Substantial content
    
    return score;
  }
  
  calculateRelevanceScore(
    context: Context,
    query: ContextQuery
  ): number {
    // Check title relevance
    const title = context.content.title || context.metadata.documentTitle || '';
    const titleScore = this.calculateTextRelevance(title, query.keywords) * 2; // Double weight for title
    
    // Check content relevance
    const content = context.content.content || '';
    const contentScore = this.calculateTextRelevance(content, query.keywords);
    
    return Math.min((titleScore + contentScore) / 3, 1);
  }
  
  private calculateTextRelevance(text: string, keywords: string[]): number {
    const lowerText = text.toLowerCase();
    let matchCount = 0;
    
    for (const keyword of keywords) {
      if (lowerText.includes(keyword.toLowerCase())) {
        matchCount++;
      }
    }
    
    return keywords.length > 0 ? matchCount / keywords.length : 0;
  }
}

class IssueScorer implements Scorer {
  calculateQualityScore(context: Context): number {
    const issue = context.content;
    
    let score = 0;
    
    // Has description
    if (issue.body && issue.body.length > 100) score += 0.3;
    
    // Has labels
    if (issue.labels && issue.labels.length > 0) score += 0.2;
    
    // Has activity (comments)
    if (issue.comments > 0) score += 0.2;
    
    // Is open (more relevant for current work)
    if (issue.state === 'open') score += 0.3;
    
    return score;
  }
  
  calculateRelevanceScore(
    context: Context,
    query: ContextQuery
  ): number {
    const issue = context.content;
    
    // Check title relevance
    const titleScore = this.calculateTextRelevance(issue.title, query.keywords) * 1.5;
    
    // Check body relevance
    const bodyScore = this.calculateTextRelevance(issue.body || '', query.keywords);
    
    // Check label relevance
    const labelScore = this.calculateLabelRelevance(issue.labels || [], query.keywords);
    
    return Math.min((titleScore + bodyScore + labelScore) / 3, 1);
  }
  
  private calculateTextRelevance(text: string, keywords: string[]): number {
    const lowerText = text.toLowerCase();
    let score = 0;
    
    for (const keyword of keywords) {
      const keywordLower = keyword.toLowerCase();
      const occurrences = (lowerText.match(new RegExp(keywordLower, 'g')) || []).length;
      if (occurrences > 0) {
        score += Math.min(occurrences / 5, 1); // Cap at 5 occurrences
      }
    }
    
    return keywords.length > 0 ? score / keywords.length : 0;
  }
  
  private calculateLabelRelevance(labels: string[], keywords: string[]): number {
    let matchCount = 0;
    
    for (const label of labels) {
      const labelLower = label.toLowerCase();
      if (keywords.some(keyword => labelLower.includes(keyword.toLowerCase()))) {
        matchCount++;
      }
    }
    
    return labels.length > 0 ? matchCount / labels.length : 0;
  }
}

class PRScorer implements Scorer {
  calculateQualityScore(context: Context): number {
    const pr = context.content;
    
    let score = 0;
    
    // Has description
    if (pr.body && pr.body.length > 100) score += 0.2;
    
    // Has labels
    if (pr.labels && pr.labels.length > 0) score += 0.15;
    
    // Not a draft
    if (!pr.draft) score += 0.15;
    
    // Reasonable size
    const totalChanges = (pr.additions || 0) + (pr.deletions || 0);
    if (totalChanges > 0 && totalChanges < 500) score += 0.2;
    else if (totalChanges >= 500 && totalChanges < 1000) score += 0.1;
    
    // Has reasonable number of files
    if (pr.changedFiles > 0 && pr.changedFiles < 20) score += 0.15;
    
    // Is merged (completed work)
    if (pr.state === 'closed' && context.metadata.mergedAt) score += 0.15;
    
    return score;
  }
  
  calculateRelevanceScore(
    context: Context,
    query: ContextQuery
  ): number {
    // Similar to issue scorer
    return new IssueScorer().calculateRelevanceScore(context, query);
  }
}

class CommitScorer implements Scorer {
  calculateQualityScore(context: Context): number {
    const commit = context.content;
    
    let score = 0;
    
    // Has meaningful message
    if (commit.message && commit.message.length > 20) score += 0.3;
    
    // Has description (not just title)
    if (commit.message && commit.message.includes('\n\n')) score += 0.2;
    
    // Reasonable size
    const changes = (commit.additions || 0) + (commit.deletions || 0);
    if (changes > 0 && changes < 200) score += 0.3;
    else if (changes >= 200 && changes < 500) score += 0.2;
    
    // Has associated PR/issue
    if (/\#\d+/.test(commit.message || '')) score += 0.2;
    
    return score;
  }
  
  calculateRelevanceScore(
    context: Context,
    query: ContextQuery
  ): number {
    const commit = context.content;
    const message = commit.message || '';
    
    let score = 0;
    for (const keyword of query.keywords) {
      if (message.toLowerCase().includes(keyword.toLowerCase())) {
        score += 1;
      }
    }
    
    return query.keywords.length > 0 ? score / query.keywords.length : 0;
  }
}