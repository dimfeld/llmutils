import { describe, it, expect } from 'bun:test';
import { IssueParser } from './parser.js';
import type { GitHubIssue } from './types.js';

describe('IssueParser', () => {
  const parser = new IssueParser();

  it('should parse basic issue', () => {
    const issue: GitHubIssue = {
      number: 123,
      title: 'Add feature X',
      body: 'This is a simple issue body',
      state: 'open',
      html_url: 'https://github.com/owner/repo/issues/123',
      user: { login: 'testuser' },
      labels: [],
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    const parsed = parser.parse(issue);
    
    expect(parsed.title).toBe('Add feature X');
    expect(parsed.body).toBe('This is a simple issue body');
    expect(parsed.sections.has('description')).toBe(true);
    expect(parsed.sections.get('description')).toBe('This is a simple issue body');
  });

  it('should extract sections from markdown', () => {
    const issue: GitHubIssue = {
      number: 123,
      title: 'Bug report',
      body: `## Description
This is a bug report

## Requirements
- Fix the bug
- Add tests

## Technical Details
The issue is in the parser module`,
      state: 'open',
      html_url: 'https://github.com/owner/repo/issues/123',
      user: { login: 'testuser' },
      labels: [],
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    const parsed = parser.parse(issue);
    
    expect(parsed.sections.has('description')).toBe(true);
    expect(parsed.sections.get('description')).toContain('This is a bug report');
    
    expect(parsed.sections.has('requirements')).toBe(true);
    expect(parsed.sections.get('requirements')).toContain('- Fix the bug');
    
    expect(parsed.sections.has('technical details')).toBe(true);
    expect(parsed.sections.get('technical details')).toContain('The issue is in the parser module');
  });

  it('should extract code blocks', () => {
    const issue: GitHubIssue = {
      number: 123,
      title: 'Code example',
      body: `Here is some code:

\`\`\`typescript
const x = 42;
console.log(x);
\`\`\`

And inline code: \`npm install\``,
      state: 'open',
      html_url: 'https://github.com/owner/repo/issues/123',
      user: { login: 'testuser' },
      labels: [],
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    const parsed = parser.parse(issue);
    
    // We should have at least one code block (the typescript one)
    expect(parsed.codeBlocks.length).toBeGreaterThan(0);
    
    // Check we have the typescript block
    const tsBlock = parsed.codeBlocks.find(b => b.language === 'typescript');
    expect(tsBlock).toBeDefined();
    expect(tsBlock?.code).toContain('const x = 42');
  });

  it('should extract links and references', () => {
    const issue: GitHubIssue = {
      number: 123,
      title: 'Links test',
      body: `See #456 and #789
      
Check [the docs](https://example.com/docs)

Also see https://github.com/owner/repo/pull/100`,
      state: 'open',
      html_url: 'https://github.com/owner/repo/issues/123',
      user: { login: 'testuser' },
      labels: [],
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    const parsed = parser.parse(issue);
    
    expect(parsed.links).toContain('#456');
    expect(parsed.links).toContain('#789');
    expect(parsed.links).toContain('https://example.com/docs');
    expect(parsed.links).toContain('https://github.com/owner/repo/pull/100');
  });

  it('should extract mentions', () => {
    const issue: GitHubIssue = {
      number: 123,
      title: 'Mentions test',
      body: 'CC @alice @bob for review',
      state: 'open',
      html_url: 'https://github.com/owner/repo/issues/123',
      user: { login: 'testuser' },
      labels: [],
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    const parsed = parser.parse(issue);
    
    expect(parsed.mentions).toContain('@alice');
    expect(parsed.mentions).toContain('@bob');
  });

  it('should analyze issue type from labels', () => {
    const issue: GitHubIssue = {
      number: 123,
      title: 'Some issue',
      body: 'Description',
      state: 'open',
      html_url: 'https://github.com/owner/repo/issues/123',
      user: { login: 'testuser' },
      labels: [{ name: 'bug' }, { name: 'high-priority' }],
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    const parsed = parser.parse(issue);
    const type = parser.analyzeType(parsed, issue.labels.map(l => l.name));
    
    expect(type).toBe('bug');
  });

  it('should analyze issue type from title', () => {
    const issue: GitHubIssue = {
      number: 123,
      title: 'Fix broken login',
      body: 'The login is not working',
      state: 'open',
      html_url: 'https://github.com/owner/repo/issues/123',
      user: { login: 'testuser' },
      labels: [],
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    const parsed = parser.parse(issue);
    const type = parser.analyzeType(parsed, []);
    
    expect(type).toBe('bug');
  });

  it('should analyze feature type from title', () => {
    const issue: GitHubIssue = {
      number: 123,
      title: 'Add dark mode support',
      body: 'We need dark mode',
      state: 'open',
      html_url: 'https://github.com/owner/repo/issues/123',
      user: { login: 'testuser' },
      labels: [],
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    const parsed = parser.parse(issue);
    const type = parser.analyzeType(parsed, []);
    
    expect(type).toBe('feature');
  });
});