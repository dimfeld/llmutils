import { BaseContextProvider } from './base_provider.js';
import { Context, ContextType, ContextFilter } from './types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'glob';
import { createHash } from 'node:crypto';

export class DocumentationProvider extends BaseContextProvider {
  type = 'documentation';
  private baseDir: string;
  private docCache: Map<string, Context> = new Map();
  
  constructor(baseDir: string = process.cwd()) {
    super();
    this.baseDir = baseDir;
  }
  
  async isAvailable(): Promise<boolean> {
    try {
      await fs.access(this.baseDir);
      // Check if there are any markdown files
      const files = await glob('**/*.md', {
        cwd: this.baseDir,
        ignore: ['**/node_modules/**', '**/.git/**']
      });
      return files.length > 0;
    } catch {
      return false;
    }
  }
  
  async gather(options: {
    query?: string;
    filters?: ContextFilter[];
    limit?: number;
  }): Promise<Context[]> {
    const contexts: Context[] = [];
    
    // Get all documentation files
    const files = await glob('**/*.md', {
      cwd: this.baseDir,
      ignore: ['**/node_modules/**', '**/.git/**']
    });
    
    for (const file of files) {
      const context = await this.getDocContext(file);
      if (!context) continue;
      
      // Apply filters
      if (options.filters && !this.matchesFilters(context, options.filters)) {
        continue;
      }
      
      // Check query match
      if (options.query) {
        const content = JSON.stringify(context).toLowerCase();
        if (!content.includes(options.query.toLowerCase())) {
          continue;
        }
      }
      
      contexts.push(context);
      
      if (options.limit && contexts.length >= options.limit) {
        break;
      }
    }
    
    return contexts;
  }
  
  async list(): Promise<Context[]> {
    const contexts: Context[] = [];
    const files = await glob('**/*.md', {
      cwd: this.baseDir,
      ignore: ['**/node_modules/**', '**/.git/**']
    });
    
    for (const file of files) {
      const context = await this.getDocContext(file);
      if (context) {
        contexts.push(context);
      }
    }
    
    return contexts;
  }
  
  private async getDocContext(filePath: string): Promise<Context | null> {
    const fullPath = path.isAbsolute(filePath) 
      ? filePath 
      : path.join(this.baseDir, filePath);
    
    // Check cache
    if (this.docCache.has(fullPath)) {
      return this.docCache.get(fullPath)!;
    }
    
    try {
      const stats = await fs.stat(fullPath);
      const content = await fs.readFile(fullPath, 'utf-8');
      
      const metadata = this.extractMetadata(content, filePath);
      
      const context: Context = {
        id: this.generateId(fullPath),
        type: ContextType.Documentation,
        source: {
          type: 'file',
          location: fullPath
        },
        content,
        metadata: {
          file: path.relative(this.baseDir, fullPath),
          title: metadata.title,
          description: metadata.description,
          tags: metadata.tags,
          lastModified: stats.mtime,
          size: stats.size
        },
        relevance: 1.0,
        timestamp: new Date()
      };
      
      this.docCache.set(fullPath, context);
      return context;
    } catch (error) {
      return null;
    }
  }
  
  private extractMetadata(content: string, filePath: string): {
    title: string;
    description?: string;
    tags: string[];
  } {
    const lines = content.split('\n');
    let title = path.basename(filePath, '.md');
    let description: string | undefined;
    const tags: string[] = [];
    
    // Extract title from first heading
    for (const line of lines) {
      if (line.startsWith('# ')) {
        title = line.slice(2).trim();
        break;
      }
    }
    
    // Extract description from first paragraph
    let inParagraph = false;
    const descLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      if (line.trim() === '') {
        if (inParagraph) break;
        continue;
      }
      inParagraph = true;
      descLines.push(line);
      if (descLines.length >= 3) break;
    }
    if (descLines.length > 0) {
      description = descLines.join(' ').trim();
    }
    
    // Extract tags from content
    const tagMatches = content.matchAll(/#(\w+)/g);
    for (const match of tagMatches) {
      tags.push(match[1]);
    }
    
    return { title, description, tags: [...new Set(tags)] };
  }
  
  private matchesFilters(context: Context, filters: ContextFilter[]): boolean {
    for (const filter of filters) {
      const value = this.getFieldValue(context, filter.field);
      
      switch (filter.operator) {
        case 'eq':
          if (value !== filter.value) return false;
          break;
        case 'neq':
          if (value === filter.value) return false;
          break;
        case 'contains':
          if (!String(value).includes(String(filter.value))) return false;
          break;
        case 'regex':
          if (!new RegExp(String(filter.value)).test(String(value))) return false;
          break;
      }
    }
    
    return true;
  }
  
  private getFieldValue(context: Context, field: string): any {
    const parts = field.split('.');
    let value: any = context;
    
    for (const part of parts) {
      value = value?.[part];
      if (value === undefined) return undefined;
    }
    
    return value;
  }
  
  private generateId(filePath: string): string {
    return createHash('sha256').update(filePath).digest('hex').slice(0, 16);
  }
}