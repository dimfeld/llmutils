import { readFile } from 'fs/promises';
import { glob } from 'glob';
import path from 'path';
import matter from 'gray-matter';
import type { Context, ContextQuery } from '../types.js';
import { ContextProvider } from './base.js';
import { ContextType } from '../types.js';

interface DocumentMetadata {
  title?: string;
  description?: string;
  tags?: string[];
  author?: string;
  date?: Date;
  [key: string]: any;
}

export class DocumentationContextProvider extends ContextProvider {
  type = ContextType.Documentation;
  priority = 8;
  
  constructor(
    private workDir: string,
    config = {}
  ) {
    super(config);
  }
  
  async gather(query: ContextQuery): Promise<Context[]> {
    const contexts: Context[] = [];
    
    // Search for documentation files
    const files = await this.findDocumentationFiles();
    
    // Process each file
    for (const file of files) {
      const content = await readFile(file, 'utf-8');
      
      // Skip if doesn't match keywords
      if (!this.matchesKeywords(content, query.keywords)) {
        continue;
      }
      
      // Parse markdown with frontmatter
      const { data: metadata, content: body } = matter(content);
      
      // Extract relevant sections
      const sections = this.extractSections(body, query.keywords);
      
      for (const section of sections) {
        const context = this.createContext(
          {
            title: section.title,
            content: section.content,
            fullDocument: body
          },
          {
            type: 'file',
            location: file
          },
          {
            ...metadata,
            documentTitle: metadata.title || this.extractTitle(body),
            section: section.title,
            format: 'markdown',
            keywords: query.keywords
          }
        );
        
        contexts.push(context);
      }
    }
    
    // Limit results
    const limit = query.maxResults || this.config.maxResults || 30;
    return contexts.slice(0, limit);
  }
  
  async validate(context: Context): Promise<boolean> {
    try {
      await readFile(context.source.location, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }
  
  async refresh(context: Context): Promise<Context> {
    const content = await readFile(context.source.location, 'utf-8');
    const { data: metadata, content: body } = matter(content);
    
    return this.createContext(
      {
        ...context.content,
        fullDocument: body
      },
      context.source,
      {
        ...context.metadata,
        ...metadata,
        lastModified: new Date()
      }
    );
  }
  
  private async findDocumentationFiles(): Promise<string[]> {
    const patterns = [
      '**/*.md',
      '**/*.mdx',
      '**/README*',
      '**/CONTRIBUTING*',
      '**/docs/**/*',
      '**/documentation/**/*'
    ];
    
    const files: string[] = [];
    
    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        cwd: this.workDir,
        ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
        absolute: true,
        nocase: true
      });
      files.push(...matches);
    }
    
    // Remove duplicates
    return [...new Set(files)];
  }
  
  private extractSections(content: string, keywords: string[]): Array<{
    title: string;
    content: string;
    level: number;
  }> {
    const sections: Array<{ title: string; content: string; level: number }> = [];
    const lines = content.split('\n');
    
    let currentSection: { title: string; content: string[]; level: number } | null = null;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      
      if (headingMatch) {
        // Save previous section if it matches keywords
        if (currentSection) {
          const sectionContent = currentSection.content.join('\n');
          if (this.matchesKeywords(
            currentSection.title + ' ' + sectionContent,
            keywords
          )) {
            sections.push({
              title: currentSection.title,
              content: sectionContent.trim(),
              level: currentSection.level
            });
          }
        }
        
        // Start new section
        currentSection = {
          title: headingMatch[2],
          content: [],
          level: headingMatch[1].length
        };
      } else if (currentSection) {
        currentSection.content.push(line);
      }
    }
    
    // Don't forget the last section
    if (currentSection) {
      const sectionContent = currentSection.content.join('\n');
      if (this.matchesKeywords(
        currentSection.title + ' ' + sectionContent,
        keywords
      )) {
        sections.push({
          title: currentSection.title,
          content: sectionContent.trim(),
          level: currentSection.level
        });
      }
    }
    
    // If no sections match, but the document does, include the whole thing
    if (sections.length === 0 && this.matchesKeywords(content, keywords)) {
      sections.push({
        title: this.extractTitle(content) || 'Document',
        content: this.extractSnippet(content, keywords, 1000),
        level: 1
      });
    }
    
    return sections;
  }
  
  private extractTitle(content: string): string | null {
    // Look for first heading
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1] : null;
  }
}