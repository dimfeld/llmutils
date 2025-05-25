import { readFile } from 'fs/promises';
import { parse } from '@babel/parser';
import traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { glob } from 'glob';
import path from 'path';
import type { 
  Context, 
  ContextQuery, 
  CodeFile, 
  CodeSection 
} from '../types.js';
import { ContextProvider } from './base.js';
import { ContextType } from '../types.js';

export class CodeContextProvider extends ContextProvider {
  type = ContextType.Code;
  priority = 10;
  
  constructor(
    private workDir: string,
    config = {}
  ) {
    super(config);
  }
  
  async gather(query: ContextQuery): Promise<Context[]> {
    const contexts: Context[] = [];
    
    // Search for relevant code files
    const files = await this.searchCode(query.keywords);
    
    // Process files in batches
    const fileContexts = await this.batchProcess(
      files,
      async (file) => this.processFile(file, query),
      5
    );
    
    // Flatten and filter
    for (const fileContext of fileContexts) {
      contexts.push(...fileContext);
    }
    
    // Limit results
    const limit = query.maxResults || this.config.maxResults || 50;
    return contexts.slice(0, limit);
  }
  
  async validate(context: Context): Promise<boolean> {
    // Check if file still exists and hasn't changed significantly
    try {
      const currentContent = await readFile(context.source.location, 'utf-8');
      const originalHash = context.metadata.contentHash;
      const currentHash = this.hashContent(currentContent);
      
      return originalHash === currentHash;
    } catch {
      return false;
    }
  }
  
  async refresh(context: Context): Promise<Context> {
    const content = await readFile(context.source.location, 'utf-8');
    const file: CodeFile = {
      path: context.source.location,
      content,
      language: context.metadata.language || 'javascript',
      size: content.length
    };
    
    // Re-extract the section
    const sections = await this.extractRelevantSections(file, {
      keywords: context.metadata.keywords || []
    } as ContextQuery);
    
    if (sections.length > 0) {
      return this.createContext(
        sections[0],
        context.source,
        {
          ...context.metadata,
          contentHash: this.hashContent(content),
          lastModified: new Date()
        }
      );
    }
    
    return context;
  }
  
  private async searchCode(keywords: string[]): Promise<CodeFile[]> {
    const files: CodeFile[] = [];
    
    // Search for files containing keywords
    const patterns = [
      '**/*.ts',
      '**/*.tsx', 
      '**/*.js',
      '**/*.jsx',
      '**/*.py',
      '**/*.java',
      '**/*.go',
      '**/*.rs'
    ];
    
    const allFiles: string[] = [];
    
    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        cwd: this.workDir,
        ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
        absolute: true
      });
      allFiles.push(...matches);
    }
    
    // Check each file for keywords
    for (const filePath of allFiles) {
      try {
        const content = await readFile(filePath, 'utf-8');
        
        if (this.matchesKeywords(content, keywords)) {
          files.push({
            path: filePath,
            content,
            language: this.detectLanguage(filePath),
            size: content.length
          });
        }
      } catch (error) {
        // Skip files that can't be read
        console.debug(`Skipping file ${filePath}:`, error);
      }
    }
    
    return files;
  }
  
  private async processFile(file: CodeFile, query: ContextQuery): Promise<Context[]> {
    const contexts: Context[] = [];
    
    // Extract relevant sections
    const sections = await this.extractRelevantSections(file, query);
    
    for (const section of sections) {
      const context = this.createContext(
        section,
        { 
          type: 'file', 
          location: file.path 
        },
        {
          language: file.language,
          symbols: section.symbols,
          dependencies: section.dependencies,
          keywords: query.keywords,
          contentHash: this.hashContent(file.content),
          fileSize: file.size
        }
      );
      
      contexts.push(context);
    }
    
    return contexts;
  }
  
  private async extractRelevantSections(
    file: CodeFile,
    query: ContextQuery
  ): Promise<CodeSection[]> {
    const sections: CodeSection[] = [];
    
    if (file.language === 'typescript' || file.language === 'javascript') {
      // Use AST parsing for JS/TS files
      try {
        const ast = this.parseFile(file);
        const relevantNodes = this.findRelevantNodes(ast, query);
        
        for (const node of relevantNodes) {
          sections.push(this.nodeToSection(node, file));
        }
      } catch (error) {
        // Fallback to text-based extraction
        console.debug(`AST parsing failed for ${file.path}:`, error);
        sections.push(...this.extractTextSections(file, query));
      }
    } else {
      // Use text-based extraction for other languages
      sections.push(...this.extractTextSections(file, query));
    }
    
    return sections;
  }
  
  private parseFile(file: CodeFile): t.File {
    return parse(file.content, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true
    });
  }
  
  private findRelevantNodes(ast: t.File, query: ContextQuery): t.Node[] {
    const relevantNodes: t.Node[] = [];
    const keywords = query.keywords.map(k => k.toLowerCase());
    
    traverse(ast, {
      enter(path: NodePath) {
        const node = path.node;
        
        // Check if node or its children contain keywords
        const nodeText = this.nodeToText(node).toLowerCase();
        
        if (keywords.some(keyword => nodeText.includes(keyword))) {
          // Add function, class, or top-level nodes
          if (
            t.isFunctionDeclaration(node) ||
            t.isClassDeclaration(node) ||
            t.isVariableDeclaration(node) ||
            t.isExportDeclaration(node)
          ) {
            relevantNodes.push(node);
            path.skip(); // Don't traverse children
          }
        }
      }
    });
    
    return relevantNodes;
  }
  
  private nodeToSection(node: t.Node, file: CodeFile): CodeSection {
    const start = node.loc?.start.line || 1;
    const end = node.loc?.end.line || 1;
    const lines = file.content.split('\n');
    
    // Include some context before and after
    const contextLines = 2;
    const startLine = Math.max(1, start - contextLines);
    const endLine = Math.min(lines.length, end + contextLines);
    
    const code = lines.slice(startLine - 1, endLine).join('\n');
    
    return {
      code,
      startLine,
      endLine,
      symbols: this.extractSymbols(node),
      dependencies: this.extractDependencies(node)
    };
  }
  
  private extractTextSections(file: CodeFile, query: ContextQuery): CodeSection[] {
    const sections: CodeSection[] = [];
    const lines = file.content.split('\n');
    const keywords = query.keywords.map(k => k.toLowerCase());
    
    // Find lines containing keywords
    const relevantLines: number[] = [];
    
    lines.forEach((line, index) => {
      const lowerLine = line.toLowerCase();
      if (keywords.some(keyword => lowerLine.includes(keyword))) {
        relevantLines.push(index);
      }
    });
    
    // Group nearby lines into sections
    const contextSize = 10; // Lines before and after
    const processedLines = new Set<number>();
    
    for (const lineIndex of relevantLines) {
      if (processedLines.has(lineIndex)) continue;
      
      const start = Math.max(0, lineIndex - contextSize);
      const end = Math.min(lines.length - 1, lineIndex + contextSize);
      
      // Mark lines as processed
      for (let i = start; i <= end; i++) {
        processedLines.add(i);
      }
      
      const code = lines.slice(start, end + 1).join('\n');
      
      sections.push({
        code,
        startLine: start + 1,
        endLine: end + 1,
        symbols: this.extractTextSymbols(code, file.language),
        dependencies: []
      });
    }
    
    return sections;
  }
  
  private extractSymbols(node: t.Node): string[] {
    const symbols: string[] = [];
    
    if (t.isFunctionDeclaration(node) && node.id) {
      symbols.push(node.id.name);
    } else if (t.isClassDeclaration(node) && node.id) {
      symbols.push(node.id.name);
    } else if (t.isVariableDeclaration(node)) {
      node.declarations.forEach(decl => {
        if (t.isIdentifier(decl.id)) {
          symbols.push(decl.id.name);
        }
      });
    }
    
    return symbols;
  }
  
  private extractDependencies(node: t.Node): string[] {
    const dependencies: string[] = [];
    
    traverse(node, {
      ImportDeclaration(path) {
        dependencies.push(path.node.source.value);
      },
      CallExpression(path) {
        if (
          t.isIdentifier(path.node.callee, { name: 'require' }) &&
          path.node.arguments.length > 0 &&
          t.isStringLiteral(path.node.arguments[0])
        ) {
          dependencies.push(path.node.arguments[0].value);
        }
      }
    });
    
    return [...new Set(dependencies)];
  }
  
  private extractTextSymbols(code: string, language: string): string[] {
    const symbols: string[] = [];
    
    // Simple regex-based extraction
    const patterns: Record<string, RegExp[]> = {
      javascript: [
        /(?:function|const|let|var|class)\s+(\w+)/g,
        /(\w+)\s*[:=]\s*(?:async\s+)?(?:function|\()/g
      ],
      typescript: [
        /(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/g,
        /(\w+)\s*[:=]\s*(?:async\s+)?(?:function|\()/g
      ],
      python: [
        /(?:def|class)\s+(\w+)/g
      ],
      java: [
        /(?:class|interface|enum)\s+(\w+)/g,
        /(?:public|private|protected)?\s*(?:static)?\s*\w+\s+(\w+)\s*\(/g
      ],
      go: [
        /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/g,
        /type\s+(\w+)/g
      ]
    };
    
    const langPatterns = patterns[language] || patterns.javascript;
    
    for (const pattern of langPatterns) {
      let match;
      while ((match = pattern.exec(code)) !== null) {
        if (match[1]) {
          symbols.push(match[1]);
        }
      }
    }
    
    return [...new Set(symbols)];
  }
  
  private nodeToText(node: t.Node): string {
    // Simple text extraction from AST node
    // In real implementation, would use @babel/generator
    return JSON.stringify(node);
  }
  
  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
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
      '.cs': 'csharp',
      '.rb': 'ruby',
      '.php': 'php',
      '.swift': 'swift',
      '.kt': 'kotlin'
    };
    
    return langMap[ext] || 'text';
  }
  
  private hashContent(content: string): string {
    const crypto = require('crypto');
    return crypto
      .createHash('sha256')
      .update(content)
      .digest('hex')
      .substring(0, 16);
  }
}