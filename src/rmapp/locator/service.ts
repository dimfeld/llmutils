import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import type { Octokit } from 'octokit';
import type { CodeLocation, GitDiff, DiffFile, DiffLine } from './types';
import type { ReviewComment, PullRequestContext } from '../reviews/types';
import { SymbolIndex } from './symbol_index';
import { DiffMapper } from './diff_mapper';
import { ContextMatcher } from './context_matcher';
import { ReferenceResolver } from './reference_resolver';
import { SmartLocator } from './smart_locator';
import { LocationCache } from './cache';

export class LocationService {
  private symbolIndex: SymbolIndex;
  private diffMapper?: DiffMapper;
  private contextMatcher: ContextMatcher;
  private resolver: ReferenceResolver;
  private smartLocator: SmartLocator;
  private cache: LocationCache;

  constructor(
    private octokit: Octokit,
    private owner: string,
    private repo: string,
    private workDir: string
  ) {
    this.symbolIndex = new SymbolIndex();
    this.contextMatcher = new ContextMatcher();
    this.resolver = new ReferenceResolver(this.symbolIndex, this.contextMatcher);
    this.smartLocator = new SmartLocator(this.resolver, this.contextMatcher, this.symbolIndex);
    this.cache = new LocationCache();
  }

  async initialize(files: string[]): Promise<void> {
    // Build symbol index
    await this.symbolIndex.buildIndex(files);
  }

  async initializeWithDiff(pr: PullRequestContext): Promise<void> {
    // Get PR diff
    const diff = await this.getDiff(pr);
    this.diffMapper = new DiffMapper(diff);
  }

  async locateFromComment(
    comment: ReviewComment,
    pr: PullRequestContext
  ): Promise<CodeLocation[]> {
    const locations: CodeLocation[] = [];

    // Check cache first
    const cacheContext = {
      prNumber: pr.number,
      fileHash: await this.getFileHash(comment.path || ''),
    };

    const cached = await this.cache.get(comment.id.toString(), cacheContext);
    if (cached) {
      return [cached];
    }

    // Inline comments have explicit location
    if (comment.type === 'inline' && comment.path && comment.line) {
      const location: CodeLocation = {
        file: comment.path,
        startLine: comment.line,
        endLine: comment.line,
        type: 'block',
      };
      locations.push(location);
      
      // Cache the result
      this.cache.set(comment.id.toString(), location, cacheContext);
      return locations;
    }

    // Extract references from comment body
    const references = this.extractReferences(comment.body);

    // Build context for resolution
    const context = await this.buildContext(comment, pr);

    // Resolve each reference
    for (const ref of references) {
      try {
        const location = await this.smartLocator.locate(ref, context);
        locations.push(location);
        
        // Cache successful resolution
        this.cache.set(ref, location, cacheContext);
      } catch (error) {
        console.warn(`Could not resolve reference "${ref}":`, error);
      }
    }

    return locations;
  }

  private extractReferences(commentBody: string): string[] {
    const references: string[] = [];

    // Split into sentences/phrases
    const phrases = commentBody.split(/[.!?;\n]+/).filter(s => s.trim());

    for (const phrase of phrases) {
      // Skip if too long (probably not a reference)
      if (phrase.length > 100) continue;

      // Check if it contains reference patterns
      if (this.looksLikeReference(phrase)) {
        references.push(phrase.trim());
      }
    }

    return references;
  }

  private looksLikeReference(text: string): boolean {
    // File references
    if (/\.(ts|js|tsx|jsx|py|java|go|rs)\b/.test(text)) return true;
    
    // Line references
    if (/\b(line|L)\s*\d+\b/i.test(text)) return true;
    
    // Function/class references
    if (/\b(function|method|class|interface|type)\s+\w+\b/i.test(text)) return true;
    
    // Relative references
    if (/\b(above|below|previous|next|this)\s+(function|method|class|block)\b/i.test(text)) return true;
    
    // Symbol-like words (camelCase, PascalCase)
    if (/\b[a-z]+[A-Z][a-zA-Z]*\b|\b[A-Z][a-zA-Z]+\b/.test(text)) return true;

    return false;
  }

  private async buildContext(
    comment: ReviewComment,
    pr: PullRequestContext
  ): Promise<any> {
    // Get relevant files
    const files = [];
    
    if (comment.path) {
      const fullPath = `${this.workDir}/${comment.path}`;
      if (existsSync(fullPath)) {
        files.push({
          path: comment.path,
          content: readFileSync(fullPath, 'utf-8'),
        });
      }
    }

    return {
      comment,
      prContext: pr,
      files,
      diff: await this.getDiffContent(pr),
    };
  }

  private async getDiff(pr: PullRequestContext): Promise<GitDiff> {
    const files = await this.octokit.rest.pulls.listFiles({
      owner: this.owner,
      repo: this.repo,
      pull_number: pr.number,
    });

    const diffFiles: DiffFile[] = [];
    const changedFiles: string[] = [];

    for (const file of files.data) {
      changedFiles.push(file.filename);
      
      if (!file.patch) continue;

      const hunks = this.parsePatch(file.patch);
      diffFiles.push({
        path: file.filename,
        hunks,
      });
    }

    return {
      files: diffFiles,
      changedFiles,
    };
  }

  private parsePatch(patch: string): DiffFile['hunks'] {
    const hunks: DiffFile['hunks'] = [];
    const lines = patch.split('\n');
    
    let currentHunk: DiffFile['hunks'][0] | null = null;
    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
      const hunkHeader = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      
      if (hunkHeader) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }
        
        oldLine = parseInt(hunkHeader[1], 10);
        newLine = parseInt(hunkHeader[3], 10);
        
        currentHunk = {
          oldStart: oldLine,
          oldLines: parseInt(hunkHeader[2] || '1', 10),
          newStart: newLine,
          newLines: parseInt(hunkHeader[4] || '1', 10),
          lines: [],
        };
      } else if (currentHunk) {
        if (line.startsWith('+')) {
          currentHunk.lines.push({
            type: 'add',
            content: line.substring(1),
            newLine: newLine++,
          });
        } else if (line.startsWith('-')) {
          currentHunk.lines.push({
            type: 'delete',
            content: line.substring(1),
            oldLine: oldLine++,
          });
        } else if (line.startsWith(' ')) {
          currentHunk.lines.push({
            type: 'context',
            content: line.substring(1),
            oldLine: oldLine++,
            newLine: newLine++,
          });
        }
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }

    return hunks;
  }

  private async getDiffContent(pr: PullRequestContext): Promise<string> {
    try {
      const response = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: pr.number,
        mediaType: {
          format: 'diff',
        },
      });

      return response.data as unknown as string;
    } catch (error) {
      console.error('Failed to get diff:', error);
      return '';
    }
  }

  private async getFileHash(filePath: string): Promise<string> {
    if (!filePath) return 'no-file';
    
    const fullPath = `${this.workDir}/${filePath}`;
    if (!existsSync(fullPath)) return 'not-found';

    try {
      const content = readFileSync(fullPath, 'utf-8');
      return createHash('sha256')
        .update(content)
        .digest('hex')
        .substring(0, 16);
    } catch (error) {
      return 'error';
    }
  }

  // Map location from old version to new version
  mapLocationToNewVersion(location: CodeLocation): CodeLocation | null {
    if (!this.diffMapper) return location;
    return this.diffMapper.mapLocation(location, 'oldToNew');
  }

  // Map location from new version to old version  
  mapLocationToOldVersion(location: CodeLocation): CodeLocation | null {
    if (!this.diffMapper) return location;
    return this.diffMapper.mapLocation(location, 'newToOld');
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheStats() {
    return this.cache.getStats();
  }
}