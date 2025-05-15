import stringComparison from 'string-comparison';
import type { ClosestMatchResult } from './types';

/**
 * Configuration options for the closest match algorithm
 */
export interface ClosestMatchConfig {
  /**
   * Minimum similarity score (0 to 1) required to consider a match
   * Higher values mean stricter matching
   * @default 0.6
   */
  similarityThreshold?: number;

  /**
   * Maximum number of close matches to return
   * @default 1
   */
  maxMatches?: number;
}

/**
 * Splits a string into lines, preserving line endings
 */
export function splitLinesWithEndings(content: string): string[] {
  if (!content) return [];

  // Split the content into lines
  const lines = content.split('\n');

  // Handle trailing newline case
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  // Add back the newline characters except for the last line
  return lines.map((line, index) => line + (index === lines.length - 1 ? '' : '\n'));
}

/**
 * Finds the closest matching blocks of text in a file content to the given search lines
 */
export function findClosestMatches(
  fileContent: string,
  searchLines: string[],
  config: ClosestMatchConfig = {}
): ClosestMatchResult[] {
  const { similarityThreshold = 0.6, maxMatches = 1 } = config;
  const searchStr = searchLines.join('');
  const fileLines = splitLinesWithEndings(fileContent);

  if (searchLines.length === 0 || fileLines.length === 0 || searchLines.length > fileLines.length) {
    return [];
  }

  const results: ClosestMatchResult[] = [];
  const searchLineCount = searchLines.length;

  for (let i = 0; i <= fileLines.length - searchLineCount; i++) {
    const chunkLines = fileLines.slice(i, i + searchLineCount);
    const chunkStr = chunkLines.join('');
    const similarity = stringComparison.diceCoefficient.similarity(searchStr, chunkStr);

    if (similarity >= similarityThreshold) {
      results.push({
        lines: chunkLines,
        startLine: i,
        endLine: i - 1 + searchLineCount,
        score: similarity,
      });
    }
  }

  // Sort by score descending and take top N matches
  return results.sort((a, b) => b.score - a.score).slice(0, maxMatches);
}
