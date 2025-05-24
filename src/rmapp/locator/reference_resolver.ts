import type { LocationMatch, CodeLocation } from './types';
import type { ReviewComment, ReviewContext } from '../reviews/types';
import { SymbolIndex } from './symbol_index';
import { ContextMatcher } from './context_matcher';

export class ReferenceResolver {
  constructor(
    private symbolIndex: SymbolIndex,
    private contextMatcher: ContextMatcher
  ) {}

  async resolveReference(
    reference: string,
    context: ReviewContext
  ): Promise<LocationMatch[]> {
    const matches: LocationMatch[] = [];

    // Try different resolution strategies
    const strategies = [
      this.resolveExplicitReference.bind(this),
      this.resolveSymbolicReference.bind(this),
      this.resolveRelativeReference.bind(this),
      this.resolveContextualReference.bind(this),
    ];

    for (const strategy of strategies) {
      const strategyMatches = await strategy(reference, context);
      matches.push(...strategyMatches);
    }

    // Deduplicate and rank
    return this.rankMatches(this.deduplicateMatches(matches));
  }

  private async resolveExplicitReference(
    reference: string,
    context: ReviewContext
  ): Promise<LocationMatch[]> {
    const matches: LocationMatch[] = [];

    // File:line pattern
    const fileLineMatch = reference.match(/([\w\-/.]+\.(\w+)):(\d+)/);
    if (fileLineMatch) {
      const [, file, , lineStr] = fileLineMatch;
      const line = parseInt(lineStr, 10);
      
      matches.push({
        location: {
          file,
          startLine: line,
          endLine: line,
          type: 'block',
        },
        confidence: 1.0,
        matchType: 'exact',
        evidence: [`Explicit reference: ${file}:${line}`],
      });
    }

    // Line number only (use comment's file)
    const lineMatch = reference.match(/\b(?:line|L)\s*(\d+)\b/i);
    if (lineMatch && context.comment.path) {
      const line = parseInt(lineMatch[1], 10);
      
      matches.push({
        location: {
          file: context.comment.path,
          startLine: line,
          endLine: line,
          type: 'block',
        },
        confidence: 0.9,
        matchType: 'exact',
        evidence: [`Line ${line} in current file`],
      });
    }

    return matches;
  }

  private async resolveSymbolicReference(
    reference: string,
    context: ReviewContext
  ): Promise<LocationMatch[]> {
    const matches: LocationMatch[] = [];

    // Extract potential symbol names
    const symbolPattern = /\b([A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)*)\b/g;
    const potentialSymbols = reference.match(symbolPattern) || [];

    for (const symbolName of potentialSymbols) {
      // Skip common words
      if (this.isCommonWord(symbolName)) continue;

      const symbols = this.symbolIndex.findSymbol(symbolName, {
        file: context.comment.path,
        nearLine: context.comment.line,
      });

      for (const symbol of symbols) {
        matches.push({
          location: symbol.location,
          confidence: symbol.file === context.comment.path ? 0.9 : 0.7,
          matchType: 'exact',
          evidence: [`Symbol: ${symbol.name} (${symbol.type})`],
        });
      }
    }

    return matches;
  }

  private async resolveRelativeReference(
    reference: string,
    context: ReviewContext
  ): Promise<LocationMatch[]> {
    const patterns = {
      above: /the\s+(\w+)\s+above/i,
      below: /the\s+(\w+)\s+below/i,
      previous: /previous\s+(\w+)/i,
      next: /next\s+(\w+)/i,
      this: /this\s+(\w+)/i,
    };

    for (const [direction, pattern] of Object.entries(patterns)) {
      const match = reference.match(pattern);
      if (match) {
        const targetType = match[1].toLowerCase();
        const baseLocation: CodeLocation = context.comment.location ? {
          ...context.comment.location,
          endLine: context.comment.location.endLine || context.comment.location.startLine,
          type: 'block' as const,
        } : {
          file: context.comment.path || '',
          startLine: context.comment.line || 1,
          endLine: context.comment.line || 1,
          type: 'block' as const,
        };
        return this.findRelativeTarget(
          baseLocation,
          direction,
          targetType
        );
      }
    }

    return [];
  }

  private async findRelativeTarget(
    baseLocation: CodeLocation,
    direction: string,
    targetType: string
  ): Promise<LocationMatch[]> {
    const matches: LocationMatch[] = [];
    const symbols = this.symbolIndex.getSymbolsInFile(baseLocation.file);

    // Map target type to symbol types
    const symbolTypes = this.mapTargetTypeToSymbolTypes(targetType);

    // Filter symbols by type and position
    const candidates = symbols.filter(symbol => {
      if (!symbolTypes.includes(symbol.type)) return false;

      switch (direction) {
        case 'above':
        case 'previous':
          return symbol.location.endLine < baseLocation.startLine;
        case 'below':
        case 'next':
          return symbol.location.startLine > baseLocation.endLine;
        case 'this':
          return (
            symbol.location.startLine <= baseLocation.startLine &&
            symbol.location.endLine >= baseLocation.endLine
          );
        default:
          return false;
      }
    });

    // Sort by distance
    const sorted = candidates.sort((a, b) => {
      const distA = Math.abs(
        a.location.startLine - baseLocation.startLine
      );
      const distB = Math.abs(
        b.location.startLine - baseLocation.startLine
      );
      return distA - distB;
    });

    // Take closest match
    if (sorted.length > 0) {
      matches.push({
        location: sorted[0].location,
        confidence: 0.8,
        matchType: 'relative',
        evidence: [`${direction} ${targetType}: ${sorted[0].name}`],
      });
    }

    return matches;
  }

  private mapTargetTypeToSymbolTypes(targetType: string): string[] {
    const mapping: Record<string, string[]> = {
      function: ['function', 'method'],
      method: ['method', 'function'],
      class: ['class', 'interface'],
      interface: ['interface', 'class'],
      type: ['type', 'interface'],
      variable: ['variable'],
      const: ['variable'],
      let: ['variable'],
    };

    return mapping[targetType] || ['function', 'class', 'method', 'variable'];
  }

  private async resolveContextualReference(
    reference: string,
    context: ReviewContext
  ): Promise<LocationMatch[]> {
    const matches: LocationMatch[] = [];

    // Use context matcher for fuzzy search
    for (const file of context.files) {
      const contextMatches = this.contextMatcher.findByContext(
        reference,
        file
      );
      matches.push(...contextMatches);
    }

    return matches;
  }

  private isCommonWord(word: string): boolean {
    const common = [
      'the', 'this', 'that', 'and', 'or', 'but', 'for', 'with',
      'from', 'to', 'in', 'on', 'at', 'by', 'up', 'down',
      'if', 'then', 'else', 'when', 'where', 'why', 'how',
      'should', 'could', 'would', 'can', 'will', 'must',
      'is', 'are', 'was', 'were', 'been', 'be',
    ];
    return common.includes(word.toLowerCase());
  }

  private deduplicateMatches(matches: LocationMatch[]): LocationMatch[] {
    const seen = new Map<string, LocationMatch>();

    for (const match of matches) {
      const key = `${match.location.file}:${match.location.startLine}-${match.location.endLine}`;
      const existing = seen.get(key);
      
      if (!existing || match.confidence > existing.confidence) {
        seen.set(key, match);
      }
    }

    return Array.from(seen.values());
  }

  private rankMatches(matches: LocationMatch[]): LocationMatch[] {
    return matches.sort((a, b) => {
      // First by confidence
      if (a.confidence !== b.confidence) {
        return b.confidence - a.confidence;
      }

      // Then by match type
      const typeOrder = { exact: 0, relative: 1, fuzzy: 2, contextual: 3 };
      const aOrder = typeOrder[a.matchType];
      const bOrder = typeOrder[b.matchType];
      
      return aOrder - bOrder;
    });
  }
}