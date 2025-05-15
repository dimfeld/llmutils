import { test, expect, describe } from 'bun:test';
import { findClosestMatches, splitLinesWithEndings } from './closest_match';
import { hunkToBeforeAfter } from './udiff-simple/parse.ts';

describe('findClosestMatches', () => {
  const fileContent = `Line 1
Line 2
Line 3 with change
Line 4
Line 5
Line 6 Exact Match
Line 7 Exact Match
Line 8 Exact Match
Line 9
Line 10 Another Close Match
Line 11 Another Close Match
Line 12`;

  test('should find an exact match', () => {
    const searchLines = ['Line 6 Exact Match\n', 'Line 7 Exact Match\n', 'Line 8 Exact Match\n'];
    const result = findClosestMatches(fileContent, searchLines);
    expect(result.length).toBe(1);
    expect(result[0].score).toBe(1);
    expect(result[0].startLine).toBe(5);
    expect(result[0].endLine).toBe(7);
    expect(result[0].lines).toEqual(searchLines);
  });

  test('should find a close match', () => {
    const searchLines = ['Line 10 Anoter Close Match\n', 'Line 11 Another Close Match\n'];
    const result = findClosestMatches(fileContent, searchLines, { similarityThreshold: 0.7 });
    expect(result.length).toBe(1);
    expect(result[0].score).toBeGreaterThan(0.7);
    expect(result[0].startLine).toBe(9);
    expect(result[0].endLine).toBe(10);
    expect(result[0].lines).toEqual([
      'Line 10 Another Close Match\n',
      'Line 11 Another Close Match\n',
    ]);
  });

  test('should return empty if below threshold', () => {
    const searchLines = ['Completely different line\n'];
    const result = findClosestMatches(fileContent, searchLines, { similarityThreshold: 0.9 });
    expect(result.length).toBe(0);
  });

  test('should return multiple matches when requested', () => {
    const searchLines = ['Line 1\n'];
    // Create a file with multiple similar lines
    const multiMatchContent = `Line 1
Line 2
Line 3
Line 1
Line 5
Line 1`;

    const result = findClosestMatches(multiMatchContent, searchLines, { maxMatches: 3 });
    expect(result.length).toBe(3);
    expect(result[0].score).toBe(1);
    expect(result[1].score).toBe(1);
    expect(result[2].score).toBe(1);

    // Check that we got all three matches at the correct positions
    const startLines = result.map((r) => r.startLine).sort((a, b) => a - b);
    expect(startLines).toEqual([0, 3, 5]);
  });

  test('should handle no matches in file', () => {
    const searchLines = ['This text does not exist in the file\n'];
    const result = findClosestMatches(fileContent, searchLines);
    expect(result.length).toBe(0);
  });

  test('should handle empty file content', () => {
    const searchLines = ['Some text\n'];
    const result = findClosestMatches('', searchLines);
    expect(result.length).toBe(0);
  });

  test('should handle empty search lines', () => {
    const result = findClosestMatches(fileContent, []);
    expect(result.length).toBe(0);
  });

  test('should handle whitespace differences', () => {
    const searchLines = ['Line 6  Exact Match\n'];
    const result = findClosestMatches(fileContent, searchLines, { similarityThreshold: 0.8 });
    expect(result.length).toBe(1);
    expect(result[0].score).toBeGreaterThan(0.8);
    expect(result[0].startLine).toBe(5);
  });

  test('should handle case differences', () => {
    const searchLines = ['line 6 exact match\n'];
    const result = findClosestMatches(fileContent, searchLines, { similarityThreshold: 0.7 });
    expect(result.length).toBe(1);
    expect(result[0].score).toBeGreaterThan(0.7);
    expect(result[0].startLine).toBe(5);
  });

  test('should handle small typos', () => {
    const searchLines = ['Line 6 Exct Matc\n'];
    const result = findClosestMatches(fileContent, searchLines, { similarityThreshold: 0.7 });
    expect(result.length).toBe(1);
    expect(result[0].score).toBeGreaterThan(0.7);
    expect(result[0].startLine).toBe(5);
  });

  test('should handle last line without newline', () => {
    const searchLines = ['Line 12'];
    const result = findClosestMatches(fileContent, searchLines);
    expect(result.length).toBe(1);
    expect(result[0].score).toBe(1);
    expect(result[0].startLine).toBe(11);
    expect(result[0].endLine).toBe(11);
  });

  test('should handle search lines longer than file content', () => {
    const longSearchLines = Array(fileContent.split('\n').length + 5).fill('Line\n');
    const result = findClosestMatches(fileContent, longSearchLines);
    expect(result.length).toBe(0);
  });

  test('should return best match first when multiple matches exist', () => {
    const searchLines = ['Line 3 with chage\n'];
    const result = findClosestMatches(fileContent, searchLines, {
      similarityThreshold: 0.7,
      maxMatches: 3,
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].startLine).toBe(2);
  });
});
