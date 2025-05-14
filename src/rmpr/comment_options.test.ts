import { describe, test, expect } from 'bun:test';
import { parseRmprOptions } from './comment_options.ts';

describe('parseRmprOptions', () => {
  test('parses single --rmpr line with multiple options', () => {
    const commentBody = 'Please fix this\n--rmpr include-all no-imports with-importers';
    const result = parseRmprOptions(commentBody);
    expect(result).toEqual({
      includeAll: true,
      noImports: true,
      withImporters: true,
    });
  });

  test('parses multiple --rmpr lines', () => {
    const commentBody = 'Please fix this\n--rmpr include-all\n--rmpr no-imports';
    const result = parseRmprOptions(commentBody);
    expect(result).toEqual({
      includeAll: true,
      noImports: true,
    });
  });

  test('parses --rmpr include with multiple paths', () => {
    const commentBody = '--rmpr include src/utils.ts,pr:*.ts';
    const result = parseRmprOptions(commentBody);
    expect(result).toEqual({
      include: ['src/utils.ts', 'pr:*.ts'],
    });
  });

  test('parses --rmpr rmfilter with additional options', () => {
    const commentBody = '--rmpr rmfilter --grep example --exclude node_modules';
    const result = parseRmprOptions(commentBody);
    expect(result).toEqual({
      rmfilter: ['--grep', 'example', '--exclude', 'node_modules'],
    });
  });

  test('returns null for comment with no --rmpr lines', () => {
    const commentBody = 'Just a regular comment';
    const result = parseRmprOptions(commentBody);
    expect(result).toBeNull();
  });

  test('handles empty --rmpr line', () => {
    const commentBody = '--rmpr \nSome other content';
    const result = parseRmprOptions(commentBody);
    expect(result).toBeNull();
  });

  test('parses mixed options with quoted paths', () => {
    const commentBody =
      '--rmpr include "src/utils.ts"\nrmpr: no-imports\n--rmpr rmfilter "--grep example"';
    const result = parseRmprOptions(commentBody);
    expect(result).toEqual({
      include: ['src/utils.ts'],
      noImports: true,
      rmfilter: ['--grep', 'example'],
    });
  });
});
