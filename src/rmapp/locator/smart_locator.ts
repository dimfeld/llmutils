import type { CodeLocation, LocationMatch } from './types';
import { LocationNotFoundError } from './types';
import type { ReviewContext } from '../reviews/types';
import { ReferenceResolver } from './reference_resolver';
import { ContextMatcher } from './context_matcher';
import { SymbolIndex } from './symbol_index';

export class SmartLocator {
  constructor(
    private resolver: ReferenceResolver,
    private contextMatcher: ContextMatcher,
    private symbolIndex: SymbolIndex
  ) {}

  async locate(
    reference: string,
    context: ReviewContext
  ): Promise<CodeLocation> {
    // Get all possible matches
    let matches = await this.findAllMatches(reference, context);

    // If no matches, try fuzzy search
    if (matches.length === 0) {
      const fuzzyMatches = await this.fuzzySearch(reference, context);
      matches.push(...fuzzyMatches);
    }

    // Still no matches, throw error with suggestions
    if (matches.length === 0) {
      const suggestions = this.suggestAlternatives(reference, context);
      throw new LocationNotFoundError(reference, suggestions);
    }

    // Multiple matches, use context to disambiguate
    if (matches.length > 1) {
      return this.disambiguate(matches, context);
    }

    return matches[0].location;
  }

  private async findAllMatches(
    reference: string,
    context: ReviewContext
  ): Promise<LocationMatch[]> {
    return this.resolver.resolveReference(reference, context);
  }

  private async fuzzySearch(
    reference: string,
    context: ReviewContext
  ): Promise<LocationMatch[]> {
    const matches: LocationMatch[] = [];

    // Try breaking down the reference
    const words = reference.split(/\s+/).filter(w => w.length > 2);
    
    for (const word of words) {
      // Skip common words
      if (this.isCommonWord(word)) continue;

      // Try as symbol
      const symbols = this.symbolIndex.findSymbol(word, {
        file: context.comment.path,
      });

      for (const symbol of symbols.slice(0, 3)) {
        matches.push({
          location: symbol.location,
          confidence: 0.5,
          matchType: 'fuzzy',
          evidence: [`Fuzzy match: ${symbol.name}`],
        });
      }
    }

    // Try contextual search with relaxed threshold
    for (const file of context.files) {
      const contextMatches = this.contextMatcher.findByContext(
        reference,
        file
      ).filter(m => m.confidence > 0.5);
      
      matches.push(...contextMatches);
    }

    return matches;
  }

  private suggestAlternatives(
    reference: string,
    context: ReviewContext
  ): string[] {
    const suggestions: string[] = [];

    // Extract words that might be symbols
    const words = reference
      .split(/\s+/)
      .filter(w => w.length > 2 && !this.isCommonWord(w));

    for (const word of words) {
      // Find similar symbol names
      const allSymbols = new Set<string>();
      
      if (context.comment.path) {
        const fileSymbols = this.symbolIndex.getSymbolsInFile(context.comment.path);
        fileSymbols.forEach(s => allSymbols.add(s.name));
      }

      // Find similar names
      for (const symbolName of allSymbols) {
        const similarity = this.stringSimilarity(word.toLowerCase(), symbolName.toLowerCase());
        if (similarity > 0.6 && similarity < 1.0) {
          suggestions.push(`Did you mean '${symbolName}'?`);
        }
      }
    }

    // Add general suggestions
    if (suggestions.length === 0) {
      suggestions.push(
        'Try using a more specific reference',
        'Include the file name (e.g., "file.ts:42")',
        'Reference a specific function or class name'
      );
    }

    return suggestions.slice(0, 5);
  }

  private async disambiguate(
    matches: LocationMatch[],
    context: ReviewContext
  ): Promise<CodeLocation> {
    // Use various signals to pick best match
    const scores = matches.map(match => ({
      match,
      score: this.scoreMatch(match, context),
    }));

    // Sort by score
    scores.sort((a, b) => b.score - a.score);

    // If top two are close, might need to warn
    if (scores.length > 1 && scores[0].score - scores[1].score < 0.1) {
      console.warn(
        `Ambiguous location reference "${context.comment.body.substring(0, 50)}...", picking best match:`,
        scores[0].match.location
      );
    }

    return scores[0].match.location;
  }

  private scoreMatch(match: LocationMatch, context: ReviewContext): number {
    let score = match.confidence;

    // Boost if in changed files
    if (context.prContext && this.isInChangedFiles(match.location.file, context)) {
      score += 0.2;
    }

    // Boost if near other comments
    if (this.isNearOtherComments(match.location, context)) {
      score += 0.1;
    }

    // Boost if matches comment patterns
    if (this.matchesCommentPattern(match, context)) {
      score += 0.1;
    }

    // Prefer exact matches
    if (match.matchType === 'exact') {
      score += 0.2;
    } else if (match.matchType === 'relative') {
      score += 0.1;
    }

    return Math.min(score, 1.0);
  }

  private isInChangedFiles(file: string, context: ReviewContext): boolean {
    // Check if file is mentioned in PR context
    if (context.diff) {
      return context.diff.includes(file);
    }

    // Check if file is in the context files
    return context.files.some(f => f.path === file);
  }

  private isNearOtherComments(
    location: CodeLocation,
    context: ReviewContext
  ): boolean {
    if (!context.thread) return false;

    // Check if other comments in thread reference nearby lines
    for (const comment of context.thread.comments) {
      if (comment.id === context.comment.id) continue;
      
      if (comment.path === location.file && comment.line) {
        const distance = Math.abs(comment.line - location.startLine);
        if (distance < 50) {
          return true;
        }
      }
    }

    return false;
  }

  private matchesCommentPattern(
    match: LocationMatch,
    context: ReviewContext
  ): boolean {
    const comment = context.comment.body.toLowerCase();
    
    // Check if comment mentions the type
    if (
      (match.location.type === 'function' && comment.includes('function')) ||
      (match.location.type === 'class' && comment.includes('class')) ||
      (match.location.type === 'method' && comment.includes('method'))
    ) {
      return true;
    }

    // Check if symbol name is mentioned
    if (match.location.symbol && comment.includes(match.location.symbol.toLowerCase())) {
      return true;
    }

    return false;
  }

  private isCommonWord(word: string): boolean {
    const common = [
      'the', 'this', 'that', 'and', 'or', 'but', 'for', 'with',
      'from', 'to', 'in', 'on', 'at', 'by', 'up', 'down',
    ];
    return common.includes(word.toLowerCase());
  }

  private stringSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) return 1.0;

    const distance = this.levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
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

    return matrix[str2.length][str1.length];
  }
}