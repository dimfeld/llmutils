import type { GitHubIssue, ParsedIssue, CodeSnippet, IssueAnalysis } from './types.js';
import { log } from '../../logging.js';

export class IssueParser {
  private readonly sectionHeaders = [
    'description',
    'requirements',
    'acceptance criteria',
    'technical details',
    'technical',
    'context',
    'background',
    'solution',
    'approach',
    'implementation',
    'expected behavior',
    'actual behavior',
    'steps to reproduce',
    'todo',
    'tasks',
  ];

  parse(issue: GitHubIssue): ParsedIssue {
    const sections = this.extractSections(issue.body || '');
    const codeBlocks = this.extractCodeBlocks(issue.body || '');
    const links = this.extractLinks(issue.body || '');
    const mentions = this.extractMentions(issue.body || '');

    return {
      title: issue.title,
      body: issue.body || '',
      sections,
      codeBlocks,
      links,
      mentions,
    };
  }

  private extractSections(body: string): Map<string, string> {
    const sections = new Map<string, string>();
    const lines = body.split('\n');
    
    let currentSection = 'description';
    let sectionContent: string[] = [];
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Check if this line is a section header
      const headerMatch = trimmedLine.match(/^#+\s+(.+)$/);
      if (headerMatch) {
        const headerText = headerMatch[1].toLowerCase();
        
        // Check if it matches any of our known sections
        const matchedSection = this.sectionHeaders.find(header => 
          headerText.includes(header) || header.includes(headerText)
        );
        
        if (matchedSection) {
          // Save previous section
          if (sectionContent.length > 0) {
            sections.set(currentSection, sectionContent.join('\n').trim());
          }
          
          // Start new section
          currentSection = matchedSection;
          sectionContent = [];
          continue;
        }
      }
      
      // Add line to current section
      sectionContent.push(line);
    }
    
    // Save last section
    if (sectionContent.length > 0) {
      sections.set(currentSection, sectionContent.join('\n').trim());
    }
    
    return sections;
  }

  private extractCodeBlocks(body: string): CodeSnippet[] {
    const codeBlocks: CodeSnippet[] = [];
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    
    let match;
    while ((match = codeBlockRegex.exec(body)) !== null) {
      const language = match[1] || 'plaintext';
      const code = match[2].trim();
      
      if (code) {
        codeBlocks.push({
          language,
          code,
        });
      }
    }
    
    // Also extract inline code that might be file paths or commands
    const inlineCodeRegex = /`([^`]+)`/g;
    const inlineMatches = body.matchAll(inlineCodeRegex);
    
    for (const match of inlineMatches) {
      const code = match[1];
      // Check if it looks like a file path or command
      if (code.includes('/') || code.includes('.') || code.includes(' ')) {
        codeBlocks.push({
          language: 'inline',
          code,
          description: 'Inline code reference',
        });
      }
    }
    
    return codeBlocks;
  }

  private extractLinks(body: string): string[] {
    const links: string[] = [];
    
    // Extract markdown links
    const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;
    while ((match = markdownLinkRegex.exec(body)) !== null) {
      links.push(match[2]);
    }
    
    // Extract raw URLs
    const urlRegex = /https?:\/\/[^\s<>[\]()]+/g;
    const urlMatches = body.match(urlRegex);
    if (urlMatches) {
      links.push(...urlMatches);
    }
    
    // Extract issue/PR references
    const issueRefRegex = /#(\d+)/g;
    const issueMatches = body.matchAll(issueRefRegex);
    for (const match of issueMatches) {
      links.push(`#${match[1]}`);
    }
    
    return [...new Set(links)]; // Remove duplicates
  }

  private extractMentions(body: string): string[] {
    const mentions: string[] = [];
    const mentionRegex = /@(\w+)/g;
    
    let match;
    while ((match = mentionRegex.exec(body)) !== null) {
      mentions.push(`@${match[1]}`);
    }
    
    return [...new Set(mentions)]; // Remove duplicates
  }

  analyzeType(parsedIssue: ParsedIssue, labels: string[]): IssueAnalysis['type'] {
    const title = parsedIssue.title.toLowerCase();
    const body = parsedIssue.body.toLowerCase();
    const labelNames = labels.map(l => l.toLowerCase());
    
    // Check labels first
    if (labelNames.some(l => l.includes('bug') || l.includes('fix'))) {
      return 'bug';
    }
    if (labelNames.some(l => l.includes('feature') || l.includes('enhancement'))) {
      return 'feature';
    }
    if (labelNames.some(l => l.includes('refactor'))) {
      return 'refactor';
    }
    if (labelNames.some(l => l.includes('doc') || l.includes('documentation'))) {
      return 'documentation';
    }
    if (labelNames.some(l => l.includes('test'))) {
      return 'test';
    }
    
    // Check title and body
    if (title.includes('bug') || title.includes('fix') || body.includes('bug') || body.includes('error')) {
      return 'bug';
    }
    if (title.includes('add') || title.includes('implement') || title.includes('feature')) {
      return 'feature';
    }
    if (title.includes('refactor') || title.includes('improve') || title.includes('optimize')) {
      return 'refactor';
    }
    if (title.includes('doc') || title.includes('readme')) {
      return 'documentation';
    }
    if (title.includes('test') || title.includes('spec')) {
      return 'test';
    }
    
    return 'other';
  }
}