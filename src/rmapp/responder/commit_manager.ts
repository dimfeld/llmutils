import { execSync } from 'child_process';
import type { AppliedChange, CommitInfo, CommitStats } from './types.js';
import type { ParsedReview, ChangeType } from '../reviews/types.js';

export class CommitManager {
  async createReviewCommit(
    changes: AppliedChange[],
    reviews: ParsedReview[]
  ): Promise<CommitInfo> {
    // Generate commit message
    const message = this.generateCommitMessage(changes, reviews);
    
    // Stage changes
    await this.stageChanges(changes.map(c => c.file));
    
    // Create commit
    const sha = await this.createCommit(message);
    
    // Get commit stats
    const stats = this.getCommitStats();
    
    return {
      sha,
      message,
      files: changes.map(c => c.file),
      stats
    };
  }
  
  private generateCommitMessage(
    changes: AppliedChange[],
    reviews: ParsedReview[]
  ): string {
    // Group changes by type
    const byType = this.groupChangesByType(changes);
    
    // Generate title
    const title = this.generateTitle(byType, reviews);
    
    // Generate body
    const body = this.generateBody(changes, reviews);
    
    // Add references
    const references = this.generateReferences(reviews);
    
    return `${title}\n\n${body}${references ? '\n\n' + references : ''}`;
  }
  
  private groupChangesByType(changes: AppliedChange[]): Map<ChangeType, AppliedChange[]> {
    const byType = new Map<ChangeType, AppliedChange[]>();
    
    for (const change of changes) {
      const existing = byType.get(change.type) || [];
      existing.push(change);
      byType.set(change.type, existing);
    }
    
    return byType;
  }
  
  private generateTitle(
    byType: Map<ChangeType, AppliedChange[]>,
    reviews: ParsedReview[]
  ): string {
    // Single type of change
    if (byType.size === 1) {
      const [type, changes] = Array.from(byType.entries())[0];
      return this.getTitleForType(type, changes.length);
    }
    
    // Multiple types
    const prNumber = reviews[0]?.context?.prContext?.number;
    return `Address review feedback${prNumber ? ` for #${prNumber}` : ''}`;
  }
  
  private getTitleForType(type: ChangeType, count: number): string {
    const templates: Record<ChangeType, string> = {
      errorHandling: `Add error handling to ${count} function${count > 1 ? 's' : ''}`,
      validation: `Add input validation`,
      logging: `Add logging for debugging`,
      documentation: `Add documentation and comments`,
      test: `Add test coverage`,
      refactoring: `Refactor code based on review feedback`,
      typefix: `Fix type issues`,
      performance: `Apply performance optimizations`,
      security: `Address security concerns`,
      other: `Apply review feedback`
    };
    
    return templates[type] || templates.other;
  }
  
  private generateBody(
    changes: AppliedChange[],
    reviews: ParsedReview[]
  ): string {
    const sections: string[] = [];
    
    // Group by type for better organization
    const byType = this.groupChangesByType(changes);
    
    for (const [type, typeChanges] of byType) {
      const section = this.generateTypeSection(type, typeChanges);
      sections.push(section);
    }
    
    // Add reviewer mentions
    const reviewers = new Set(reviews.map(r => r.comment.author));
    if (reviewers.size > 0) {
      sections.push(`Addresses feedback from: ${Array.from(reviewers).join(', ')}`);
    }
    
    return sections.join('\n\n');
  }
  
  private generateTypeSection(type: ChangeType, changes: AppliedChange[]): string {
    const descriptions: Record<ChangeType, string> = {
      errorHandling: 'Error Handling',
      validation: 'Input Validation',
      logging: 'Logging',
      documentation: 'Documentation',
      test: 'Tests',
      refactoring: 'Refactoring',
      typefix: 'Type Fixes',
      performance: 'Performance',
      security: 'Security',
      other: 'Other Changes'
    };
    
    const title = descriptions[type] || descriptions.other;
    const items = changes.map(c => `- ${c.file}: ${c.description}`);
    
    return `${title}:\n${items.join('\n')}`;
  }
  
  private generateReferences(reviews: ParsedReview[]): string {
    const references: string[] = [];
    
    // Add PR reference
    const prNumber = reviews[0]?.context?.prContext?.number;
    if (prNumber) {
      references.push(`Refs: #${prNumber}`);
    }
    
    // Add comment references
    const commentIds = new Set(reviews.map(r => r.comment.id).filter(Boolean));
    if (commentIds.size > 0 && commentIds.size <= 5) {
      const ids = Array.from(commentIds).join(', ');
      references.push(`Addresses review comments: ${ids}`);
    }
    
    return references.join('\n');
  }
  
  private async stageChanges(files: string[]): Promise<void> {
    const uniqueFiles = [...new Set(files)];
    
    for (const file of uniqueFiles) {
      try {
        execSync(`git add ${file}`, { encoding: 'utf-8' });
      } catch (error) {
        console.error(`Failed to stage ${file}:`, error);
      }
    }
  }
  
  private async createCommit(message: string): Promise<string> {
    try {
      // Create commit
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { encoding: 'utf-8' });
      
      // Get commit SHA
      const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
      return sha;
    } catch (error) {
      throw new Error(`Failed to create commit: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  private getCommitStats(): CommitStats {
    try {
      const stats = execSync('git diff --stat HEAD~1', { encoding: 'utf-8' });
      
      // Parse stats from git output
      const matches = stats.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
      
      if (matches) {
        return {
          files: parseInt(matches[1] || '0', 10),
          additions: parseInt(matches[2] || '0', 10),
          deletions: parseInt(matches[3] || '0', 10)
        };
      }
    } catch (error) {
      console.error('Failed to get commit stats:', error);
    }
    
    return { files: 0, additions: 0, deletions: 0 };
  }
  
  async pushCommit(remote: string = 'origin', branch?: string): Promise<void> {
    try {
      const pushCommand = branch ? `git push ${remote} ${branch}` : `git push ${remote}`;
      execSync(pushCommand, { encoding: 'utf-8' });
    } catch (error) {
      throw new Error(`Failed to push commit: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  async createFixupCommit(
    targetCommit: string,
    changes: AppliedChange[]
  ): Promise<CommitInfo> {
    // Stage changes
    await this.stageChanges(changes.map(c => c.file));
    
    // Create fixup commit
    try {
      execSync(`git commit --fixup ${targetCommit}`, { encoding: 'utf-8' });
      const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
      
      return {
        sha,
        message: `fixup! ${targetCommit}`,
        files: changes.map(c => c.file),
        stats: this.getCommitStats()
      };
    } catch (error) {
      throw new Error(`Failed to create fixup commit: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}