import type { Octokit } from 'octokit';
import type {
  CodeLocation,
  ReviewComment,
  ReviewThread,
  TextReference,
  PullRequestContext,
} from './types';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export class CodeReferenceResolver {
  constructor(
    private octokit: Octokit,
    private owner: string,
    private repo: string,
    private workDir: string
  ) {}

  async resolveReferences(
    comment: ReviewComment,
    pr: PullRequestContext
  ): Promise<CodeLocation[]> {
    const locations: CodeLocation[] = [];

    // Inline comments have explicit location
    if (comment.location) {
      locations.push(comment.location);
    } else if (comment.path && comment.line) {
      // GitHub review comment format
      locations.push({
        file: comment.path,
        startLine: comment.line,
      });
    }

    // Extract code references from text
    const textRefs = this.extractTextReferences(comment.body);
    for (const ref of textRefs) {
      const location = await this.resolveReference(ref, pr, comment);
      if (location) {
        locations.push(location);
      }
    }

    // Use context from thread
    if (comment.thread) {
      const threadLocs = await this.getThreadLocations(comment.thread);
      locations.push(...threadLocs);
    }

    // Deduplicate locations
    return this.deduplicateLocations(locations);
  }

  private extractTextReferences(text: string): TextReference[] {
    const refs: TextReference[] = [];

    // Function/class names in backticks
    const codeNames = text.matchAll(/`([\w.]+)`/g);
    for (const match of codeNames) {
      const value = match[1];
      // Determine if it's a function, class, or generic symbol
      const type = this.inferReferenceType(value, text);
      refs.push({ type, value, context: this.getContext(match, text) });
    }

    // File paths
    const filePaths = text.matchAll(/\b([\w\-/.]+\.(ts|js|tsx|jsx|json|yml|yaml|md))\b/g);
    for (const match of filePaths) {
      refs.push({ 
        type: 'file', 
        value: match[1],
        context: this.getContext(match, text),
      });
    }

    // Line numbers
    const lineRefs = text.matchAll(/\b(line|L)\s*(\d+)\b/gi);
    for (const match of lineRefs) {
      refs.push({ 
        type: 'line', 
        value: match[2],
        context: this.getContext(match, text),
      });
    }

    // Function definitions
    const funcRefs = text.matchAll(/\b(function|method|class)\s+`?([\w]+)`?/gi);
    for (const match of funcRefs) {
      const type = match[1].toLowerCase() === 'class' ? 'class' : 'function';
      refs.push({ 
        type, 
        value: match[2],
        context: this.getContext(match, text),
      });
    }

    return refs;
  }

  private inferReferenceType(value: string, context: string): TextReference['type'] {
    // Check context around the reference
    const beforeMatch = context.match(new RegExp(`(\\w+)\\s+\`${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``, 'i'));
    if (beforeMatch) {
      const word = beforeMatch[1].toLowerCase();
      if (['class', 'interface', 'type'].includes(word)) return 'class';
      if (['function', 'method', 'fn'].includes(word)) return 'function';
    }

    // Check naming conventions
    if (/^[A-Z]/.test(value)) return 'class'; // PascalCase likely a class
    if (/\(\)$/.test(value)) return 'function'; // Has parentheses

    return 'symbol';
  }

  private getContext(match: RegExpMatchArray, text: string): string {
    // Get 50 chars before and after the match
    const index = match.index || 0;
    const start = Math.max(0, index - 50);
    const end = Math.min(text.length, index + match[0].length + 50);
    return text.substring(start, end).trim();
  }

  private async resolveReference(
    ref: TextReference,
    pr: PullRequestContext,
    comment: ReviewComment
  ): Promise<CodeLocation | null> {
    switch (ref.type) {
      case 'file':
        return this.resolveFileReference(ref.value);
      
      case 'line':
        return this.resolveLineReference(ref.value, comment, ref.context);
      
      case 'function':
      case 'class':
      case 'symbol':
        return this.resolveSymbolReference(ref, comment);
      
      default:
        return null;
    }
  }

  private async resolveFileReference(filePath: string): Promise<CodeLocation | null> {
    // Check if file exists in workspace
    const fullPath = join(this.workDir, filePath);
    if (existsSync(fullPath)) {
      return {
        file: filePath,
        startLine: 1,
      };
    }

    // Try common source directories
    const commonDirs = ['src', 'lib', 'app', 'pages', 'components'];
    for (const dir of commonDirs) {
      const tryPath = join(this.workDir, dir, filePath);
      if (existsSync(tryPath)) {
        return {
          file: join(dir, filePath),
          startLine: 1,
        };
      }
    }

    return null;
  }

  private async resolveLineReference(
    lineStr: string,
    comment: ReviewComment,
    context?: string
  ): Promise<CodeLocation | null> {
    const line = parseInt(lineStr);
    if (isNaN(line)) return null;

    // If comment has a path, use it
    if (comment.path) {
      return {
        file: comment.path,
        startLine: line,
      };
    }

    // Try to infer file from context
    if (context) {
      const fileMatch = context.match(/\b([\w\-/.]+\.(ts|js|tsx|jsx))\b/);
      if (fileMatch) {
        return {
          file: fileMatch[1],
          startLine: line,
        };
      }
    }

    return null;
  }

  private async resolveSymbolReference(
    ref: TextReference,
    comment: ReviewComment
  ): Promise<CodeLocation | null> {
    // Start with the comment's file if available
    const searchFiles: string[] = [];
    
    if (comment.path) {
      searchFiles.push(comment.path);
    }

    // Add related files from the same directory
    if (comment.path) {
      const dir = comment.path.substring(0, comment.path.lastIndexOf('/'));
      // This is simplified - in production, you'd list directory files
      searchFiles.push(`${dir}/index.ts`, `${dir}/index.js`);
    }

    // Search for the symbol in files
    for (const file of searchFiles) {
      const location = await this.findSymbolInFile(file, ref.value, ref.type);
      if (location) {
        return location;
      }
    }

    return null;
  }

  private async findSymbolInFile(
    filePath: string,
    symbol: string,
    type: TextReference['type']
  ): Promise<CodeLocation | null> {
    const fullPath = join(this.workDir, filePath);
    if (!existsSync(fullPath)) return null;

    try {
      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');

      // Build appropriate regex based on type
      let patterns: RegExp[] = [];
      
      if (type === 'function') {
        patterns = [
          new RegExp(`function\\s+${symbol}\\s*\\(`),
          new RegExp(`const\\s+${symbol}\\s*=\\s*\\(`),
          new RegExp(`const\\s+${symbol}\\s*=\\s*async`),
          new RegExp(`${symbol}\\s*\\([^)]*\\)\\s*{`),
          new RegExp(`${symbol}:\\s*\\([^)]*\\)\\s*=>`),
        ];
      } else if (type === 'class') {
        patterns = [
          new RegExp(`class\\s+${symbol}\\s`),
          new RegExp(`interface\\s+${symbol}\\s`),
          new RegExp(`type\\s+${symbol}\\s*=`),
          new RegExp(`enum\\s+${symbol}\\s*{`),
        ];
      } else {
        // Generic symbol - try various patterns
        patterns = [
          new RegExp(`\\b${symbol}\\b`),
        ];
      }

      // Search for pattern in lines
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (patterns.some(p => p.test(line))) {
          return {
            file: filePath,
            startLine: i + 1,
          };
        }
      }
    } catch (error) {
      // File read error - ignore
    }

    return null;
  }

  private async getThreadLocations(thread: ReviewThread): Promise<CodeLocation[]> {
    const locations: CodeLocation[] = [];

    for (const comment of thread.comments) {
      if (comment.location) {
        locations.push(comment.location);
      } else if (comment.path && comment.line) {
        locations.push({
          file: comment.path,
          startLine: comment.line,
        });
      }
    }

    return locations;
  }

  private deduplicateLocations(locations: CodeLocation[]): CodeLocation[] {
    const seen = new Set<string>();
    const unique: CodeLocation[] = [];

    for (const loc of locations) {
      const key = `${loc.file}:${loc.startLine}:${loc.endLine || ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(loc);
      }
    }

    return unique;
  }
}