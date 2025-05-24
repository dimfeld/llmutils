import type { LocationMatch, FileContent, CodeLocation, Block } from './types';

export class ContextMatcher {
  findByContext(
    searchContext: string,
    file: FileContent
  ): LocationMatch[] {
    const matches: LocationMatch[] = [];

    // Split file into logical blocks
    const blocks = this.splitIntoBlocks(file);

    for (const block of blocks) {
      const similarity = this.calculateSimilarity(searchContext, block.content);

      if (similarity > 0.7) {
        matches.push({
          location: block.location,
          confidence: similarity,
          matchType: 'contextual',
          evidence: this.getMatchEvidence(searchContext, block),
        });
      }
    }

    return matches.sort((a, b) => b.confidence - a.confidence);
  }

  private splitIntoBlocks(file: FileContent): Block[] {
    const blocks: Block[] = [];
    const lines = file.content.split('\n');
    
    let currentBlock: string[] = [];
    let blockStart = 1;
    let blockType: Block['type'] = 'block';
    let braceLevel = 0;

    lines.forEach((line, index) => {
      const lineNum = index + 1;
      currentBlock.push(line);

      // Detect block starts
      if (line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/)) {
        if (currentBlock.length > 1) {
          // Save previous block
          blocks.push(this.createBlock(file.path, blockStart, lineNum - 1, currentBlock.slice(0, -1), blockType));
        }
        blockStart = lineNum;
        blockType = 'function';
        currentBlock = [line];
      } else if (line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+/)) {
        if (currentBlock.length > 1) {
          blocks.push(this.createBlock(file.path, blockStart, lineNum - 1, currentBlock.slice(0, -1), blockType));
        }
        blockStart = lineNum;
        blockType = 'class';
        currentBlock = [line];
      }

      // Track brace level for block boundaries
      const openBraces = (line.match(/{/g) || []).length;
      const closeBraces = (line.match(/}/g) || []).length;
      braceLevel += openBraces - closeBraces;

      // End block when braces balance
      if (braceLevel === 0 && currentBlock.length > 1 && (blockType === 'function' || blockType === 'class')) {
        blocks.push(this.createBlock(file.path, blockStart, lineNum, currentBlock, blockType));
        currentBlock = [];
        blockStart = lineNum + 1;
        blockType = 'block';
      }
    });

    // Add final block
    if (currentBlock.length > 0) {
      blocks.push(this.createBlock(file.path, blockStart, lines.length, currentBlock, blockType));
    }

    return blocks;
  }

  private createBlock(
    file: string,
    startLine: number,
    endLine: number,
    lines: string[],
    type: Block['type']
  ): Block {
    return {
      location: {
        file,
        startLine,
        endLine,
        type: type === 'function' ? 'function' : type === 'class' ? 'class' : 'block',
      },
      content: lines.join('\n'),
      type,
    };
  }

  private calculateSimilarity(context: string, content: string): number {
    // Tokenize both strings
    const contextTokens = this.tokenize(context);
    const contentTokens = this.tokenize(content);

    // Calculate various similarities
    const exactMatch = this.exactMatchScore(contextTokens, contentTokens);
    const fuzzyMatch = this.fuzzyMatchScore(contextTokens, contentTokens);
    const structuralMatch = this.structuralMatchScore(context, content);

    // Weighted combination
    return (exactMatch * 0.5) + (fuzzyMatch * 0.3) + (structuralMatch * 0.2);
  }

  private tokenize(text: string): Set<string> {
    // Extract meaningful tokens
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length > 2 && !this.isCommonWord(token));

    return new Set(tokens);
  }

  private isCommonWord(word: string): boolean {
    const common = ['the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'were', 'been'];
    return common.includes(word);
  }

  private exactMatchScore(contextTokens: Set<string>, contentTokens: Set<string>): number {
    if (contextTokens.size === 0) return 0;

    let matches = 0;
    for (const token of contextTokens) {
      if (contentTokens.has(token)) {
        matches++;
      }
    }

    return matches / contextTokens.size;
  }

  private fuzzyMatchScore(contextTokens: Set<string>, contentTokens: Set<string>): number {
    if (contextTokens.size === 0) return 0;

    let score = 0;
    for (const contextToken of contextTokens) {
      let bestMatch = 0;
      for (const contentToken of contentTokens) {
        const similarity = this.stringSimilarity(contextToken, contentToken);
        bestMatch = Math.max(bestMatch, similarity);
      }
      score += bestMatch;
    }

    return score / contextTokens.size;
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

  private structuralMatchScore(context: string, content: string): number {
    // Check for similar structure (braces, parentheses, etc.)
    const contextStructure = this.extractStructure(context);
    const contentStructure = this.extractStructure(content);

    if (contextStructure.length === 0 || contentStructure.length === 0) {
      return 0;
    }

    // Compare structural elements
    let matches = 0;
    const minLength = Math.min(contextStructure.length, contentStructure.length);
    
    for (let i = 0; i < minLength; i++) {
      if (contextStructure[i] === contentStructure[i]) {
        matches++;
      }
    }

    return matches / Math.max(contextStructure.length, contentStructure.length);
  }

  private extractStructure(text: string): string {
    // Extract structural elements
    return text
      .replace(/[^{}()\[\]<>;]/g, '')
      .replace(/\s+/g, '');
  }

  private getMatchEvidence(searchContext: string, block: Block): string[] {
    const evidence: string[] = [];
    const contextTokens = Array.from(this.tokenize(searchContext));
    const blockLines = block.content.split('\n');

    // Find lines with matching tokens
    for (const line of blockLines) {
      const lineTokens = this.tokenize(line);
      const matchingTokens = contextTokens.filter(token => lineTokens.has(token));
      
      if (matchingTokens.length > 0) {
        evidence.push(`Line contains: ${matchingTokens.join(', ')}`);
      }
    }

    // Add structural evidence
    if (block.type !== 'block') {
      evidence.push(`${block.type} block`);
    }

    return evidence.slice(0, 5); // Limit evidence items
  }

  findSimilarCode(needle: string, haystack: string): LocationMatch[] {
    const matches: LocationMatch[] = [];
    const lines = haystack.split('\n');
    const needleLines = needle.split('\n').filter(l => l.trim());

    if (needleLines.length === 0) return matches;

    // Sliding window search
    for (let i = 0; i <= lines.length - needleLines.length; i++) {
      const window = lines.slice(i, i + needleLines.length);
      const similarity = this.calculateLinesSimilarity(needleLines, window);

      if (similarity > 0.8) {
        matches.push({
          location: {
            file: '',
            startLine: i + 1,
            endLine: i + needleLines.length,
            type: 'block',
          },
          confidence: similarity,
          matchType: 'fuzzy',
          evidence: [`${Math.round(similarity * 100)}% similar`],
        });
      }
    }

    return matches;
  }

  private calculateLinesSimilarity(lines1: string[], lines2: string[]): number {
    if (lines1.length !== lines2.length) return 0;

    let totalSimilarity = 0;
    for (let i = 0; i < lines1.length; i++) {
      totalSimilarity += this.stringSimilarity(
        lines1[i].trim(),
        lines2[i].trim()
      );
    }

    return totalSimilarity / lines1.length;
  }
}