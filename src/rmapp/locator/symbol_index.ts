import { readFileSync } from 'fs';
import { parse } from '@babel/parser';
import traverse, { type NodePath } from '@babel/traverse';
import type { Node, FunctionDeclaration, ClassDeclaration, VariableDeclarator, InterfaceDeclaration, TypeAlias } from '@babel/types';
import type { Symbol, CodeLocation, SearchContext } from './types';

export class SymbolIndex {
  private symbols: Map<string, Symbol[]> = new Map();
  private fileSymbols: Map<string, Symbol[]> = new Map();

  async buildIndex(files: string[]): Promise<void> {
    for (const file of files) {
      try {
        const symbols = await this.extractSymbolsFromFile(file);
        this.addSymbols(file, symbols);
      } catch (error) {
        console.error(`Failed to index ${file}:`, error);
      }
    }
  }

  private async extractSymbolsFromFile(file: string): Promise<Symbol[]> {
    const content = readFileSync(file, 'utf-8');
    const symbols: Symbol[] = [];

    try {
      // Parse based on file extension
      const ext = file.split('.').pop();
      if (ext && ['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
        symbols.push(...this.extractJavaScriptSymbols(content, file));
      } else {
        // Fallback to regex-based extraction
        symbols.push(...this.extractSymbolsWithRegex(content, file));
      }
    } catch (error) {
      // Fallback to regex if parsing fails
      symbols.push(...this.extractSymbolsWithRegex(content, file));
    }

    return symbols;
  }

  private extractJavaScriptSymbols(content: string, file: string): Symbol[] {
    const symbols: Symbol[] = [];

    try {
      const ast = parse(content, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx'],
        errorRecovery: true,
      });

      traverse(ast, {
        FunctionDeclaration: (path: NodePath<FunctionDeclaration>) => {
          if (path.node.id) {
            symbols.push({
              name: path.node.id.name,
              type: 'function',
              location: this.nodeToLocation(path.node, file, content),
              signature: this.getFunctionSignature(path.node),
              file,
            });
          }
        },
        ClassDeclaration: (path: NodePath<ClassDeclaration>) => {
          if (path.node.id) {
            const className = path.node.id.name;
            symbols.push({
              name: className,
              type: 'class',
              location: this.nodeToLocation(path.node, file, content),
              members: this.getClassMembers(path.node),
              file,
            });
          }
        },
        VariableDeclarator: (path: NodePath<VariableDeclarator>) => {
          if (
            path.node.id.type === 'Identifier' &&
            (path.node.init?.type === 'ArrowFunctionExpression' ||
              path.node.init?.type === 'FunctionExpression')
          ) {
            symbols.push({
              name: path.node.id.name,
              type: 'function',
              location: this.nodeToLocation(path.node, file, content),
              signature: this.getFunctionSignature(path.node.init),
              file,
            });
          }
        },
        InterfaceDeclaration: (path: NodePath<InterfaceDeclaration>) => {
          if (path.node.id) {
            symbols.push({
              name: path.node.id.name,
              type: 'interface',
              location: this.nodeToLocation(path.node, file, content),
              file,
            });
          }
        },
        TypeAlias: (path: NodePath<TypeAlias>) => {
          if (path.node.id) {
            symbols.push({
              name: path.node.id.name,
              type: 'type',
              location: this.nodeToLocation(path.node, file, content),
              file,
            });
          }
        },
      });
    } catch (error) {
      console.error('AST parsing failed:', error);
    }

    return symbols;
  }

  private extractSymbolsWithRegex(content: string, file: string): Symbol[] {
    const symbols: Symbol[] = [];
    const lines = content.split('\n');

    // Function patterns
    const functionPatterns = [
      /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
      /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/,
      /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function/,
    ];

    // Class patterns
    const classPatterns = [
      /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
      /^\s*(?:export\s+)?interface\s+(\w+)/,
      /^\s*(?:export\s+)?type\s+(\w+)\s*=/,
    ];

    lines.forEach((line, index) => {
      // Check function patterns
      for (const pattern of functionPatterns) {
        const match = line.match(pattern);
        if (match) {
          symbols.push({
            name: match[1],
            type: 'function',
            location: {
              file,
              startLine: index + 1,
              endLine: index + 1,
              type: 'function',
            },
            file,
          });
          break;
        }
      }

      // Check class patterns
      for (const pattern of classPatterns) {
        const match = line.match(pattern);
        if (match) {
          const type = line.includes('interface') ? 'interface' : 
                       line.includes('type') ? 'type' : 'class';
          symbols.push({
            name: match[1],
            type,
            location: {
              file,
              startLine: index + 1,
              endLine: index + 1,
              type: 'class',
            },
            file,
          });
          break;
        }
      }
    });

    return symbols;
  }

  private nodeToLocation(node: Node, file: string, content: string): CodeLocation {
    const lines = content.split('\n');
    let startLine = 1;
    let endLine = 1;

    if (node.loc) {
      startLine = node.loc.start.line;
      endLine = node.loc.end.line;
    }

    return {
      file,
      startLine,
      endLine,
      startColumn: node.loc?.start.column,
      endColumn: node.loc?.end.column,
      type: this.getNodeType(node),
    };
  }

  private getNodeType(node: Node): CodeLocation['type'] {
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return 'function';
      case 'ClassDeclaration':
      case 'ClassExpression':
        return 'class';
      case 'VariableDeclarator':
        return 'variable';
      default:
        return 'block';
    }
  }

  private getFunctionSignature(node: any): string {
    // Simplified signature extraction
    if (node.params) {
      const params = node.params.map((p: any) => {
        if (p.type === 'Identifier') return p.name;
        if (p.type === 'RestElement') return `...${p.argument.name}`;
        return '?';
      });
      return `(${params.join(', ')})`;
    }
    return '()';
  }

  private getClassMembers(node: any): string[] {
    const members: string[] = [];
    
    if (node.body && node.body.body) {
      node.body.body.forEach((member: any) => {
        if (member.type === 'MethodDefinition' && member.key?.name) {
          members.push(member.key.name);
        } else if (member.type === 'PropertyDefinition' && member.key?.name) {
          members.push(member.key.name);
        }
      });
    }

    return members;
  }

  private addSymbols(file: string, symbols: Symbol[]): void {
    // Add to file index
    this.fileSymbols.set(file, symbols);

    // Add to name index
    for (const symbol of symbols) {
      const existing = this.symbols.get(symbol.name) || [];
      existing.push(symbol);
      this.symbols.set(symbol.name, existing);
    }
  }

  findSymbol(name: string, context?: SearchContext): Symbol[] {
    // Exact matches
    const exact = this.symbols.get(name) || [];

    // If we have a file context, prioritize symbols from that file
    if (context?.file) {
      const fileSyms = this.fileSymbols.get(context.file) || [];
      const fileMatches = fileSyms.filter(s => s.name === name);
      if (fileMatches.length > 0) {
        return fileMatches;
      }
    }

    // Fuzzy matches
    const fuzzy: Symbol[] = [];
    for (const [symbolName, symbols] of this.symbols.entries()) {
      if (symbolName.toLowerCase().includes(name.toLowerCase()) && symbolName !== name) {
        fuzzy.push(...symbols);
      }
    }

    // Rank by context
    return this.rankByContext([...exact, ...fuzzy], context);
  }

  private rankByContext(symbols: Symbol[], context?: SearchContext): Symbol[] {
    if (!context) return symbols;

    return symbols.sort((a, b) => {
      let scoreA = 0;
      let scoreB = 0;

      // Prefer symbols from the same file
      if (context.file) {
        if (a.file === context.file) scoreA += 3;
        if (b.file === context.file) scoreB += 3;
      }

      // Prefer symbols near the given line
      if (context.nearLine) {
        const distA = Math.abs(a.location.startLine - context.nearLine);
        const distB = Math.abs(b.location.startLine - context.nearLine);
        if (distA < distB) scoreA += 2;
        else if (distB < distA) scoreB += 2;
      }

      // Prefer the requested type
      if (context.preferredType) {
        if (a.type === context.preferredType) scoreA += 1;
        if (b.type === context.preferredType) scoreB += 1;
      }

      return scoreB - scoreA;
    });
  }

  getSymbolsInFile(file: string): Symbol[] {
    return this.fileSymbols.get(file) || [];
  }

  clear(): void {
    this.symbols.clear();
    this.fileSymbols.clear();
  }
}