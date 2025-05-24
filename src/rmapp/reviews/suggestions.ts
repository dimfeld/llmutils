import type {
  GitHubSuggestion,
  ProcessedSuggestion,
  ParsedSuggestion,
  SuggestionValidation,
  EnhancedSuggestion,
} from './types';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export class SuggestionHandler {
  constructor(private workDir: string) {}

  async processSuggestion(
    suggestion: GitHubSuggestion
  ): Promise<ProcessedSuggestion> {
    // Parse GitHub suggestion format
    const parsed = this.parseSuggestionBlock(suggestion.body);

    if (!parsed) {
      return {
        original: suggestion,
        parsed: null,
        validation: {
          isValid: false,
          hasConflicts: false,
          errors: ['No suggestion block found in comment'],
          warnings: [],
        },
        canAutoApply: false,
      };
    }

    // Get original code from file
    const originalCode = await this.getOriginalCode(
      suggestion.path,
      parsed.startLine,
      parsed.endLine
    );

    if (originalCode) {
      parsed.originalCode = originalCode;
    }

    // Validate suggestion
    const validation = await this.validateSuggestion(parsed, suggestion);

    // Enhance with context if valid
    let enhanced: EnhancedSuggestion | undefined;
    if (validation.isValid) {
      enhanced = await this.enhanceSuggestion(parsed, suggestion);
    }

    return {
      original: suggestion,
      parsed,
      validation,
      enhanced,
      canAutoApply: validation.isValid && !validation.hasConflicts,
    };
  }

  private parseSuggestionBlock(body: string): ParsedSuggestion | null {
    // Extract ```suggestion blocks - handle various whitespace
    const suggestionMatch = body.match(/```suggestion\s*\n([\s\S]*?)\n\s*```/);

    if (!suggestionMatch) {
      return null;
    }

    // Extract line range from comment
    const lineRangeMatch = body.match(/\b(?:lines?|L)\s+(\d+)(?:\s*-\s*(\d+))?/i);
    let startLine = 0;
    let endLine: number | undefined;
    
    if (lineRangeMatch) {
      startLine = parseInt(lineRangeMatch[1]);
      endLine = lineRangeMatch[2] ? parseInt(lineRangeMatch[2]) : undefined;
    }

    return {
      suggestedCode: suggestionMatch[1].trim(),
      startLine,
      endLine,
    };
  }

  private async getOriginalCode(
    filePath: string,
    startLine: number,
    endLine?: number
  ): Promise<string | undefined> {
    const fullPath = join(this.workDir, filePath);
    
    if (!existsSync(fullPath)) {
      return undefined;
    }

    try {
      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      
      const start = Math.max(0, startLine - 1);
      const end = endLine ? Math.min(lines.length, endLine) : start + 1;
      
      return lines.slice(start, end).join('\n');
    } catch (error) {
      console.error(`Failed to read original code from ${filePath}:`, error);
      return undefined;
    }
  }

  private async validateSuggestion(
    parsed: ParsedSuggestion,
    suggestion: GitHubSuggestion
  ): Promise<SuggestionValidation> {
    const errors: string[] = [];
    const warnings: string[] = [];
    let hasConflicts = false;

    // Check if file exists
    const fullPath = join(this.workDir, suggestion.path);
    if (!existsSync(fullPath)) {
      errors.push(`File ${suggestion.path} not found`);
      return {
        isValid: false,
        hasConflicts: false,
        errors,
        warnings,
      };
    }

    // Check line numbers are valid
    try {
      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      
      if (parsed.startLine > lines.length) {
        errors.push(`Start line ${parsed.startLine} exceeds file length (${lines.length} lines)`);
      }
      
      if (parsed.endLine && parsed.endLine > lines.length) {
        errors.push(`End line ${parsed.endLine} exceeds file length (${lines.length} lines)`);
      }
    } catch (error) {
      errors.push(`Failed to read file: ${error}`);
    }

    // Check for syntax issues in suggested code
    const syntaxIssues = this.checkSyntax(parsed.suggestedCode, suggestion.path);
    if (syntaxIssues.length > 0) {
      warnings.push(...syntaxIssues);
    }

    // Check if the change would create conflicts
    if (parsed.originalCode) {
      hasConflicts = this.detectConflicts(parsed.originalCode, parsed.suggestedCode);
      if (hasConflicts) {
        warnings.push('The suggestion may conflict with recent changes');
      }
    }

    // Validate indentation consistency
    const indentationIssue = this.checkIndentation(parsed.suggestedCode, parsed.originalCode);
    if (indentationIssue) {
      warnings.push(indentationIssue);
    }

    return {
      isValid: errors.length === 0,
      hasConflicts,
      errors,
      warnings,
    };
  }

  private checkSyntax(code: string, filePath: string): string[] {
    const issues: string[] = [];
    const ext = filePath.split('.').pop();

    if (!ext || !['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
      return issues;
    }

    // Basic syntax checks
    const brackets = { '(': 0, '{': 0, '[': 0 };
    const closeBrackets = { ')': '(', '}': '{', ']': '[' };

    for (const char of code) {
      if (char in brackets) {
        brackets[char as keyof typeof brackets]++;
      } else if (char in closeBrackets) {
        const openChar = closeBrackets[char as keyof typeof closeBrackets] as keyof typeof brackets;
        brackets[openChar]--;
        if (brackets[openChar] < 0) {
          issues.push(`Unmatched closing bracket: ${char}`);
        }
      }
    }

    for (const [bracket, count] of Object.entries(brackets)) {
      if (count > 0) {
        issues.push(`Unclosed bracket: ${bracket}`);
      }
    }

    // Check for common syntax errors
    if (code.includes(';;')) {
      issues.push('Double semicolon detected');
    }

    if (/\bif\s*\(.*\)\s*;/.test(code)) {
      issues.push('Empty if statement detected');
    }

    return issues;
  }

  private detectConflicts(original: string, suggested: string): boolean {
    // Simple conflict detection - check if original has changed significantly
    // In production, this would use more sophisticated diff algorithms
    
    // If original is empty, no conflicts
    if (!original.trim()) {
      return false;
    }

    // Check if the suggested code is completely different
    const originalLines = original.split('\n').map(l => l.trim()).filter(Boolean);
    const suggestedLines = suggested.split('\n').map(l => l.trim()).filter(Boolean);

    // If line counts differ significantly, might be a conflict
    if (Math.abs(originalLines.length - suggestedLines.length) > originalLines.length * 0.5) {
      return true;
    }

    return false;
  }

  private checkIndentation(suggested: string, original?: string): string | null {
    const suggestedLines = suggested.split('\n');
    
    // Detect indentation style from original or suggested
    let indentStyle: 'spaces' | 'tabs' | null = null;
    let indentSize = 2;

    const detectIndent = (lines: string[]) => {
      for (const line of lines) {
        const leadingWhitespace = line.match(/^(\s+)/);
        if (leadingWhitespace) {
          if (leadingWhitespace[1].includes('\t')) {
            return { style: 'tabs' as const, size: 1 };
          } else {
            return { style: 'spaces' as const, size: leadingWhitespace[1].length };
          }
        }
      }
      return null;
    };

    // Try to detect from original first
    if (original) {
      const detected = detectIndent(original.split('\n'));
      if (detected) {
        indentStyle = detected.style;
        indentSize = detected.size;
      }
    }

    // Check consistency in suggested code
    let inconsistentIndent = false;
    let lastIndentLevel = 0;

    for (const line of suggestedLines) {
      if (line.trim() === '') continue;

      const leadingWhitespace = line.match(/^(\s*)/);
      if (leadingWhitespace) {
        const whitespace = leadingWhitespace[1];
        const hasTab = whitespace.includes('\t');
        const hasSpace = whitespace.includes(' ');

        if (hasTab && hasSpace) {
          return 'Mixed tabs and spaces detected in indentation';
        }

        if (indentStyle === 'tabs' && hasSpace) {
          inconsistentIndent = true;
        } else if (indentStyle === 'spaces' && hasTab) {
          inconsistentIndent = true;
        }
      }
    }

    if (inconsistentIndent) {
      return `Inconsistent indentation style (expected ${indentStyle})`;
    }

    return null;
  }

  private async enhanceSuggestion(
    parsed: ParsedSuggestion,
    suggestion: GitHubSuggestion
  ): Promise<EnhancedSuggestion> {
    const impact = this.assessImpact(parsed, suggestion);
    const affectedSymbols = this.extractAffectedSymbols(parsed.suggestedCode);
    const requiresImports = this.detectRequiredImports(parsed.suggestedCode, suggestion.path);

    return {
      ...parsed,
      impact,
      affectedSymbols,
      requiresImports: requiresImports.length > 0 ? requiresImports : undefined,
    };
  }

  private assessImpact(
    parsed: ParsedSuggestion,
    suggestion: GitHubSuggestion
  ): 'low' | 'medium' | 'high' {
    const lineCount = parsed.suggestedCode.split('\n').length;
    const hasStructuralChanges = /\b(class|interface)\b/.test(parsed.suggestedCode);
    const hasFunctionChanges = /\bfunction\b/.test(parsed.suggestedCode);
    const hasLogicChanges = /\b(if|for|while|switch|try|catch)\b/.test(parsed.suggestedCode);

    // High impact: structural changes or many lines
    if (hasStructuralChanges || lineCount > 20) {
      return 'high';
    }

    // Medium impact: function changes or logic changes or moderate lines  
    if (hasFunctionChanges || hasLogicChanges || lineCount > 5) {
      return 'medium';
    }

    // Low impact: small changes
    return 'low';
  }

  private extractAffectedSymbols(code: string): string[] {
    const symbols: string[] = [];

    // Extract function names
    const functionMatches = code.matchAll(/(?:function|const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:=|\()/g);
    for (const match of functionMatches) {
      symbols.push(match[1]);
    }

    // Extract class names
    const classMatches = code.matchAll(/(?:class|interface|type)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g);
    for (const match of classMatches) {
      symbols.push(match[1]);
    }

    // Extract method names
    const methodMatches = code.matchAll(/([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*[{:]/g);
    for (const match of methodMatches) {
      if (!['if', 'for', 'while', 'switch', 'catch'].includes(match[1])) {
        symbols.push(match[1]);
      }
    }

    return [...new Set(symbols)];
  }

  private detectRequiredImports(code: string, filePath: string): string[] {
    const imports: string[] = [];
    const ext = filePath.split('.').pop();

    if (!ext || !['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
      return imports;
    }

    // Common patterns that might need imports
    const patterns = [
      { regex: /\bReact\b/, import: "import React from 'react';" },
      { regex: /\buseState\b/, import: "import { useState } from 'react';" },
      { regex: /\buseEffect\b/, import: "import { useEffect } from 'react';" },
      { regex: /\bpath\./, import: "import path from 'path';" },
      { regex: /\bfs\./, import: "import fs from 'fs';" },
      { regex: /\bconsole\./, import: "// console is global" },
    ];

    for (const { regex, import: importStatement } of patterns) {
      if (regex.test(code) && !importStatement.includes('//')) {
        imports.push(importStatement);
      }
    }

    // Check for unresolved symbols (simplified)
    const usedSymbols = new Set<string>();
    const symbolMatches = code.matchAll(/\b([A-Z][a-zA-Z0-9_$]*)\b/g);
    for (const match of symbolMatches) {
      usedSymbols.add(match[1]);
    }

    // These might need imports (heuristic)
    for (const symbol of usedSymbols) {
      if (!code.includes(`class ${symbol}`) && 
          !code.includes(`interface ${symbol}`) &&
          !code.includes(`type ${symbol}`) &&
          !['String', 'Number', 'Boolean', 'Object', 'Array', 'Date', 'Error'].includes(symbol)) {
        imports.push(`// TODO: Import ${symbol}`);
      }
    }

    return [...new Set(imports)];
  }

  formatSuggestionForApplication(processed: ProcessedSuggestion): string | null {
    if (!processed.parsed || !processed.canAutoApply) {
      return null;
    }

    const suggestedCode = (processed.enhanced || processed.parsed).suggestedCode;
    let result = suggestedCode;

    // Add required imports at the beginning if needed
    if (processed.enhanced?.requiresImports && processed.enhanced.requiresImports.length > 0) {
      const importsText = processed.enhanced.requiresImports.join('\n');
      result = `${importsText}\n\n${result}`;
    }

    return result;
  }
}