import type { Octokit } from 'octokit';
import type { Context, ContextQuery } from '../types.js';
import { ContextProvider } from './base.js';
import { ContextType } from '../types.js';

export class GitHubIssueProvider extends ContextProvider {
  type = ContextType.Issue;
  priority = 7;
  
  constructor(
    private octokit: Octokit,
    private owner: string,
    private repo: string,
    config = {}
  ) {
    super(config);
  }
  
  async gather(query: ContextQuery): Promise<Context[]> {
    const contexts: Context[] = [];
    
    // Search issues
    const searchQuery = this.buildSearchQuery(query);
    const issues = await this.searchIssues(searchQuery);
    
    for (const issue of issues) {
      // Skip if doesn't match additional filters
      if (query.timeRange && !this.inTimeRange(issue.created_at, query.timeRange)) {
        continue;
      }
      
      const context = this.createContext(
        {
          number: issue.number,
          title: issue.title,
          body: issue.body || '',
          state: issue.state,
          labels: issue.labels.map((l: any) => typeof l === 'string' ? l : l.name),
          comments: issue.comments
        },
        {
          type: 'api',
          location: `github:${this.owner}/${this.repo}/issues/${issue.number}`,
          version: issue.updated_at
        },
        {
          author: issue.user?.login,
          createdAt: new Date(issue.created_at),
          updatedAt: new Date(issue.updated_at),
          url: issue.html_url,
          isPullRequest: !!issue.pull_request,
          keywords: query.keywords
        }
      );
      
      contexts.push(context);
    }
    
    // Limit results
    const limit = query.maxResults || this.config.maxResults || 20;
    return contexts.slice(0, limit);
  }
  
  async validate(context: Context): Promise<boolean> {
    try {
      const issueNumber = context.content.number;
      const { data: issue } = await this.octokit.rest.issues.get({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber
      });
      
      // Check if updated
      return context.source.version === issue.updated_at;
    } catch {
      return false;
    }
  }
  
  async refresh(context: Context): Promise<Context> {
    const issueNumber = context.content.number;
    const { data: issue } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber
    });
    
    return this.createContext(
      {
        number: issue.number,
        title: issue.title,
        body: issue.body || '',
        state: issue.state,
        labels: issue.labels.map((l: any) => typeof l === 'string' ? l : l.name),
        comments: issue.comments
      },
      {
        ...context.source,
        version: issue.updated_at
      },
      {
        ...context.metadata,
        updatedAt: new Date(issue.updated_at)
      }
    );
  }
  
  private buildSearchQuery(query: ContextQuery): string {
    const parts = [
      `repo:${this.owner}/${this.repo}`,
      'is:issue'
    ];
    
    // Add keywords
    if (query.keywords.length > 0) {
      parts.push(query.keywords.join(' '));
    }
    
    return parts.join(' ');
  }
  
  private async searchIssues(searchQuery: string): Promise<any[]> {
    try {
      const { data } = await this.octokit.rest.search.issuesAndPullRequests({
        q: searchQuery,
        sort: 'updated',
        order: 'desc',
        per_page: 100
      });
      
      return data.items.filter(item => !item.pull_request);
    } catch (error) {
      console.error('Failed to search issues:', error);
      return [];
    }
  }
  
  private inTimeRange(dateStr: string, range: any): boolean {
    const date = new Date(dateStr);
    
    if (range.start && date < range.start) return false;
    if (range.end && date > range.end) return false;
    
    return true;
  }
}

export class GitHubPRProvider extends ContextProvider {
  type = ContextType.PullRequest;
  priority = 8;
  
  constructor(
    private octokit: Octokit,
    private owner: string,
    private repo: string,
    config = {}
  ) {
    super(config);
  }
  
  async gather(query: ContextQuery): Promise<Context[]> {
    const contexts: Context[] = [];
    
    // Search PRs
    const searchQuery = this.buildSearchQuery(query);
    const prs = await this.searchPRs(searchQuery);
    
    for (const pr of prs) {
      // Get additional PR details
      const details = await this.getPRDetails(pr.number);
      
      const context = this.createContext(
        {
          number: pr.number,
          title: pr.title,
          body: pr.body || '',
          state: pr.state,
          labels: pr.labels.map((l: any) => typeof l === 'string' ? l : l.name),
          draft: pr.draft || false,
          additions: details.additions,
          deletions: details.deletions,
          changedFiles: details.changed_files,
          commits: details.commits
        },
        {
          type: 'api',
          location: `github:${this.owner}/${this.repo}/pull/${pr.number}`,
          version: pr.updated_at
        },
        {
          author: pr.user?.login,
          createdAt: new Date(pr.created_at),
          updatedAt: new Date(pr.updated_at),
          mergedAt: pr.merged_at ? new Date(pr.merged_at) : undefined,
          url: pr.html_url,
          base: pr.base?.ref,
          head: pr.head?.ref,
          keywords: query.keywords
        }
      );
      
      contexts.push(context);
    }
    
    // Limit results
    const limit = query.maxResults || this.config.maxResults || 20;
    return contexts.slice(0, limit);
  }
  
  async validate(context: Context): Promise<boolean> {
    try {
      const prNumber = context.content.number;
      const { data: pr } = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber
      });
      
      return context.source.version === pr.updated_at;
    } catch {
      return false;
    }
  }
  
  async refresh(context: Context): Promise<Context> {
    const prNumber = context.content.number;
    const { data: pr } = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber
    });
    
    return this.createContext(
      {
        ...context.content,
        state: pr.state,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
        commits: pr.commits
      },
      {
        ...context.source,
        version: pr.updated_at
      },
      {
        ...context.metadata,
        updatedAt: new Date(pr.updated_at),
        mergedAt: pr.merged_at ? new Date(pr.merged_at) : undefined
      }
    );
  }
  
  private buildSearchQuery(query: ContextQuery): string {
    const parts = [
      `repo:${this.owner}/${this.repo}`,
      'is:pr'
    ];
    
    // Add keywords
    if (query.keywords.length > 0) {
      parts.push(query.keywords.join(' '));
    }
    
    return parts.join(' ');
  }
  
  private async searchPRs(searchQuery: string): Promise<any[]> {
    try {
      const { data } = await this.octokit.rest.search.issuesAndPullRequests({
        q: searchQuery,
        sort: 'updated',
        order: 'desc',
        per_page: 50
      });
      
      return data.items.filter(item => item.pull_request);
    } catch (error) {
      console.error('Failed to search PRs:', error);
      return [];
    }
  }
  
  private async getPRDetails(prNumber: number): Promise<any> {
    try {
      const { data } = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber
      });
      
      return data;
    } catch {
      return {
        additions: 0,
        deletions: 0,
        changed_files: 0,
        commits: 0
      };
    }
  }
}