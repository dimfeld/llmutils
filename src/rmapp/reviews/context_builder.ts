import type { Octokit } from 'octokit';
import type {
  ReviewComment,
  ReviewContext,
  ReviewThread,
  PullRequestContext,
  FileContent,
  CommitInfo,
} from './types';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { globby } from 'globby';

export class ReviewContextBuilder {
  constructor(
    private octokit: Octokit,
    private owner: string,
    private repo: string,
    private workDir: string
  ) {}

  async buildContext(
    comment: ReviewComment,
    pr: PullRequestContext
  ): Promise<ReviewContext> {
    // Get PR diff
    const diff = await this.getPRDiff(pr);

    // Get file content
    const files = await this.getRelevantFiles(comment, pr);

    // Get related comments
    const thread = await this.getCommentThread(comment, pr);

    // Get commit messages
    const commits = await this.getCommits(pr);

    return {
      comment,
      diff,
      files,
      thread,
      prContext: pr,
      commits,
      metadata: {
        prNumber: pr.number,
        author: comment.author,
        timestamp: comment.createdAt,
      },
    };
  }

  private async getPRDiff(pr: PullRequestContext): Promise<string> {
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
      console.error('Failed to get PR diff:', error);
      return '';
    }
  }

  private async getRelevantFiles(
    comment: ReviewComment,
    pr: PullRequestContext
  ): Promise<FileContent[]> {
    const files: FileContent[] = [];
    const processedPaths = new Set<string>();

    // Files mentioned in comment location
    if (comment.location?.file) {
      const file = await this.getFile(comment.location.file);
      if (file) {
        files.push(file);
        processedPaths.add(comment.location.file);
      }
    }

    // Files from comment path (GitHub API)
    if (comment.path && !processedPaths.has(comment.path)) {
      const file = await this.getFile(comment.path);
      if (file) {
        files.push(file);
        processedPaths.add(comment.path);
      }
    }

    // Files in same directory
    if (comment.path || comment.location?.file) {
      const basePath = comment.path || comment.location!.file;
      const relatedFiles = await this.findRelatedFiles(basePath, processedPaths);
      files.push(...relatedFiles);
    }

    // Files mentioned in comment body
    const mentionedFiles = this.extractFilePaths(comment.body);
    for (const filePath of mentionedFiles) {
      if (!processedPaths.has(filePath)) {
        const file = await this.getFile(filePath);
        if (file) {
          files.push(file);
          processedPaths.add(filePath);
        }
      }
    }

    return files;
  }

  private async getFile(filePath: string): Promise<FileContent | null> {
    const fullPath = join(this.workDir, filePath);
    
    if (!existsSync(fullPath)) {
      return null;
    }

    try {
      const content = readFileSync(fullPath, 'utf-8');
      const ext = filePath.split('.').pop() || '';
      
      return {
        path: filePath,
        content,
        language: this.getLanguageFromExtension(ext),
      };
    } catch (error) {
      console.error(`Failed to read file ${filePath}:`, error);
      return null;
    }
  }

  private getLanguageFromExtension(ext: string): string {
    const languageMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      py: 'python',
      rb: 'ruby',
      go: 'go',
      rs: 'rust',
      java: 'java',
      cpp: 'cpp',
      c: 'c',
      cs: 'csharp',
      php: 'php',
      swift: 'swift',
      kt: 'kotlin',
      scala: 'scala',
      r: 'r',
      m: 'objective-c',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      xml: 'xml',
      md: 'markdown',
      sh: 'bash',
      sql: 'sql',
    };

    return languageMap[ext] || 'text';
  }

  private async findRelatedFiles(
    basePath: string,
    processedPaths: Set<string>
  ): Promise<FileContent[]> {
    const files: FileContent[] = [];
    const dir = dirname(basePath);
    const baseFileName = basePath.split('/').pop()?.split('.')[0] || '';

    try {
      // Find files in the same directory
      const patterns = [
        `${dir}/*.ts`,
        `${dir}/*.js`,
        `${dir}/*.tsx`,
        `${dir}/*.jsx`,
      ];

      const relatedPaths = await globby(patterns, {
        cwd: this.workDir,
        onlyFiles: true,
        ignore: ['**/node_modules/**', '**/*.test.*', '**/*.spec.*'],
      });

      // Prioritize files with similar names
      const prioritizedPaths = relatedPaths.sort((a, b) => {
        const aName = a.split('/').pop() || '';
        const bName = b.split('/').pop() || '';
        const aSimilarity = this.calculateSimilarity(aName, baseFileName);
        const bSimilarity = this.calculateSimilarity(bName, baseFileName);
        return bSimilarity - aSimilarity;
      });

      // Take top 5 most related files
      for (const path of prioritizedPaths.slice(0, 5)) {
        if (!processedPaths.has(path)) {
          const file = await this.getFile(path);
          if (file) {
            files.push(file);
            processedPaths.add(path);
          }
        }
      }
    } catch (error) {
      console.error('Failed to find related files:', error);
    }

    return files;
  }

  private calculateSimilarity(str1: string, str2: string): number {
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

  private extractFilePaths(text: string): string[] {
    const paths: string[] = [];
    
    // Match file paths
    const filePathRegex = /\b([\w\-/.]+\.(ts|js|tsx|jsx|json|yml|yaml|md))\b/g;
    const matches = text.matchAll(filePathRegex);
    
    for (const match of matches) {
      paths.push(match[1]);
    }

    return [...new Set(paths)]; // Deduplicate
  }

  private async getCommentThread(
    comment: ReviewComment,
    pr: PullRequestContext
  ): Promise<ReviewThread | undefined> {
    if (comment.thread) {
      return comment.thread;
    }

    // Try to fetch thread from GitHub API
    try {
      const comments = await this.octokit.rest.pulls.listReviewComments({
        owner: this.owner,
        repo: this.repo,
        pull_number: pr.number,
      });

      // Find comments in the same thread
      const threadComments = comments.data.filter(c => {
        if (comment.path && c.path === comment.path) {
          // Check if it's near the same line
          if (comment.line && c.line) {
            return Math.abs(c.line - comment.line) <= 5;
          }
        }
        return false;
      });

      if (threadComments.length > 0) {
        return {
          id: `thread-${comment.id}`,
          comments: threadComments.map(c => this.mapGitHubComment(c)),
          resolved: false,
          originalComment: comment,
        };
      }
    } catch (error) {
      console.error('Failed to fetch comment thread:', error);
    }

    return undefined;
  }

  private mapGitHubComment(ghComment: any): ReviewComment {
    return {
      id: ghComment.id,
      type: ghComment.body.includes('```suggestion') ? 'suggestion' : 'inline',
      body: ghComment.body,
      author: ghComment.user.login,
      createdAt: new Date(ghComment.created_at),
      resolved: false,
      path: ghComment.path,
      line: ghComment.line,
      side: ghComment.side,
      diffHunk: ghComment.diff_hunk,
    };
  }

  private async getCommits(pr: PullRequestContext): Promise<CommitInfo[]> {
    try {
      const commits = await this.octokit.rest.pulls.listCommits({
        owner: this.owner,
        repo: this.repo,
        pull_number: pr.number,
      });

      return commits.data.map(commit => ({
        sha: commit.sha,
        message: commit.commit.message,
        author: commit.commit.author?.name || 'Unknown',
        timestamp: new Date(commit.commit.author?.date || Date.now()),
      }));
    } catch (error) {
      console.error('Failed to fetch commits:', error);
      return [];
    }
  }
}