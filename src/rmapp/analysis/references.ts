import type { GitHubIssue, References, RepoContext } from './types.js';
import { ClaudeCodeExecutor } from '../../rmplan/executors/claude_code.js';
import type { ClaudeCodeExecutorOptions } from '../../rmplan/executors/claude_code.js';
import { log } from '../../logging.js';

export class ReferenceExtractor {
  async extract(issue: GitHubIssue, context: RepoContext): Promise<References> {
    // Use Claude Code to intelligently extract references
    const config: ClaudeCodeExecutorOptions = {
      allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch'],
      includeDefaultTools: false,
    };

    const executor = new ClaudeCodeExecutor(
      config,
      { 
        model: 'claude-3-haiku-20240307', // Fast model for reference extraction
        baseDir: context.workDir 
      },
      { defaultExecutor: 'claude-code' }
    );

    const prompt = `Extract all relevant references from this GitHub issue and return as JSON:

Issue #${issue.number}: ${issue.title}
${issue.body || 'No description provided'}

Please extract:
1. File paths mentioned (check if they exist in the repository)
2. Referenced issues/PRs (look for #123 format)
3. Documentation links (both internal and external)
4. Code snippets with their language
5. Similar functionality in the codebase

Return a JSON object with this structure:
{
  "files": [
    { "path": "src/example.ts", "line": 42, "reason": "mentioned in issue" }
  ],
  "issues": [
    { "number": 123, "url": "https://github.com/owner/repo/issues/123" }
  ],
  "prs": [
    { "number": 456, "url": "https://github.com/owner/repo/pull/456" }
  ],
  "documentation": [
    { "url": "https://docs.example.com", "title": "API Docs", "type": "external" }
  ],
  "codeSnippets": [
    { "language": "typescript", "code": "const example = true;", "description": "Example code" }
  ]
}`;

    try {
      const result = await executor.execute(prompt);
      
      // The executor returns structured output, parse it
      const output = this.parseExecutorOutput(result);
      
      // Validate and clean the references
      return this.validateReferences(output, context);
    } catch (error) {
      log('Failed to extract references with Claude Code:', error);
      
      // Fallback to basic extraction
      return this.basicExtraction(issue, context);
    }
  }

  private parseExecutorOutput(output: any): References {
    // The output from ClaudeCodeExecutor might be wrapped in various formats
    // Try to extract JSON from the output
    let jsonStr = output;
    
    if (typeof output === 'object' && output.output) {
      jsonStr = output.output;
    }
    
    if (typeof jsonStr === 'string') {
      // Try to extract JSON from markdown code blocks
      const jsonMatch = jsonStr.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }
      
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        // If JSON parsing fails, try to extract it from the text
        const jsonStart = jsonStr.indexOf('{');
        const jsonEnd = jsonStr.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
          try {
            return JSON.parse(jsonStr.substring(jsonStart, jsonEnd + 1));
          } catch (e2) {
            log('Failed to parse JSON from executor output');
          }
        }
      }
    }
    
    // Return empty references if parsing fails
    return {
      files: [],
      issues: [],
      prs: [],
      documentation: [],
      codeSnippets: [],
    };
  }

  private validateReferences(refs: References, context: RepoContext): References {
    // Add GitHub URLs to issues and PRs if missing
    const baseUrl = `https://github.com/${context.owner}/${context.repo}`;
    
    refs.issues = refs.issues.map(issue => ({
      ...issue,
      url: issue.url || `${baseUrl}/issues/${issue.number}`,
    }));
    
    refs.prs = refs.prs.map(pr => ({
      ...pr,
      url: pr.url || `${baseUrl}/pull/${pr.number}`,
    }));
    
    return refs;
  }

  private basicExtraction(issue: GitHubIssue, context: RepoContext): References {
    const references: References = {
      files: [],
      issues: [],
      prs: [],
      documentation: [],
      codeSnippets: [],
    };
    
    const body = issue.body || '';
    const baseUrl = `https://github.com/${context.owner}/${context.repo}`;
    
    // Extract issue references
    const issueRegex = /#(\d+)/g;
    let match;
    while ((match = issueRegex.exec(body)) !== null) {
      const number = parseInt(match[1], 10);
      references.issues.push({
        number,
        url: `${baseUrl}/issues/${number}`,
      });
    }
    
    // Extract file paths
    const filePathRegex = /(?:^|\s)([\.\/]?(?:src|test|tests|lib|packages)\/[\w\-\/]+\.\w+)/gm;
    while ((match = filePathRegex.exec(body)) !== null) {
      references.files.push({
        path: match[1],
        reason: 'Mentioned in issue body',
      });
    }
    
    // Extract URLs
    const urlRegex = /https?:\/\/[^\s<>[\]()]+/g;
    const urls = body.match(urlRegex) || [];
    for (const url of urls) {
      if (url.includes('github.com') && url.includes('/pull/')) {
        const prMatch = url.match(/\/pull\/(\d+)/);
        if (prMatch) {
          references.prs.push({
            number: parseInt(prMatch[1], 10),
            url,
          });
        }
      } else if (!url.includes('github.com') || url.includes('/docs/') || url.includes('wiki')) {
        references.documentation.push({
          url,
          type: url.includes(context.repo) ? 'internal' : 'external',
        });
      }
    }
    
    // Extract code blocks
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    while ((match = codeBlockRegex.exec(body)) !== null) {
      references.codeSnippets.push({
        language: match[1] || 'plaintext',
        code: match[2].trim(),
      });
    }
    
    return references;
  }
}