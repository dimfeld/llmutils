import { BaseContextProvider } from './base_provider.js';
import { Context, ContextType, ContextFilter } from './types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'glob';
import { createHash } from 'node:crypto';

export class CodeContextProvider extends BaseContextProvider {
  type = 'code';
  private baseDir: string;
  private fileCache: Map<string, Context> = new Map();
  
  constructor(baseDir: string = process.cwd()) {
    super();
    this.baseDir = baseDir;
  }
  
  async isAvailable(): Promise<boolean> {
    try {
      await fs.access(this.baseDir);
      return true;
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
    
    // If specific file filter is provided
    if (options.filters) {
      for (const filter of options.filters) {
        if (filter.field === 'metadata.file' && filter.operator === 'eq') {
          const filePath = filter.value as string;
          const context = await this.getFileContext(filePath);
          if (context) {
            contexts.push(context);
          }
        }
      }
    }
    
    // If query is provided, search in files
    if (options.query && contexts.length === 0) {
      const files = await this.searchFiles(options.query);
      for (const file of files) {
        const context = await this.getFileContext(file);
        if (context) {
          contexts.push(context);
          if (options.limit && contexts.length >= options.limit) {
            break;
          }
        }
      }
    }
    
    return contexts;
  }
  
  async list(): Promise<Context[]> {
    const contexts: Context[] = [];
    const files = await glob('**/*.{ts,js,tsx,jsx,py,java,go,rs,cpp,c,h}', {
      cwd: this.baseDir,
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**']
    });
    
    for (const file of files) {
      const context = await this.getFileContext(file);
      if (context) {
        contexts.push(context);
      }
    }
    
    return contexts;
  }
  
  private async getFileContext(filePath: string): Promise<Context | null> {
    const fullPath = path.isAbsolute(filePath) 
      ? filePath 
      : path.join(this.baseDir, filePath);
    
    // Check cache
    if (this.fileCache.has(fullPath)) {
      return this.fileCache.get(fullPath)!;
    }
    
    try {
      const stats = await fs.stat(fullPath);
      const content = await fs.readFile(fullPath, 'utf-8');
      
      const context: Context = {
        id: this.generateId(fullPath),
        type: ContextType.Code,
        source: {
          type: 'file',
          location: fullPath
        },
        content,
        metadata: {
          file: path.relative(this.baseDir, fullPath),
          language: this.detectLanguage(fullPath),
          size: stats.size,
          lastModified: stats.mtime,
          symbols: this.extractSymbols(content, fullPath)
        },
        relevance: 1.0,
        timestamp: new Date()
      };
      
      this.fileCache.set(fullPath, context);
      return context;
    } catch (error) {
      return null;
    }
  }
  
  private async searchFiles(query: string): Promise<string[]> {
    // Simple implementation - in production, use ripgrep or similar
    const files = await glob('**/*.{ts,js,tsx,jsx,py,java,go,rs,cpp,c,h}', {
      cwd: this.baseDir,
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**']
    });
    
    const matches: string[] = [];
    const lowerQuery = query.toLowerCase();
    
    for (const file of files) {
      try {
        const content = await fs.readFile(
          path.join(this.baseDir, file), 
          'utf-8'
        );
        if (content.toLowerCase().includes(lowerQuery)) {
          matches.push(file);
        }
      } catch {
        // Skip files that can't be read
      }
    }
    
    return matches;
  }
  
  private generateId(filePath: string): string {
    return createHash('sha256').update(filePath).digest('hex').slice(0, 16);
  }
  
  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const languageMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.java': 'java',
      '.go': 'go',
      '.rs': 'rust',
      '.cpp': 'cpp',
      '.c': 'c',
      '.h': 'c'
    };
    
    return languageMap[ext] || 'unknown';
  }
  
  private extractSymbols(content: string, filePath: string): string[] {
    const symbols: string[] = [];
    const language = this.detectLanguage(filePath);
    
    // Simple regex-based symbol extraction
    // In production, use proper AST parsing
    
    if (['typescript', 'javascript'].includes(language)) {
      // Functions
      const funcMatches = content.matchAll(/(?:function|const|let|var)\s+(\w+)\s*[=\(]/g);
      for (const match of funcMatches) {
        symbols.push(match[1]);
      }
      
      // Classes
      const classMatches = content.matchAll(/class\s+(\w+)/g);
      for (const match of classMatches) {
        symbols.push(match[1]);
      }
      
      // Interfaces and types
      const typeMatches = content.matchAll(/(?:interface|type)\s+(\w+)/g);
      for (const match of typeMatches) {
        symbols.push(match[1]);
      }
    }
    
    return [...new Set(symbols)];
  }
}