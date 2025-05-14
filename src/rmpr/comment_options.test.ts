import { describe, test, expect } from 'bun:test';
import { parseRmprOptions } from './comment_options.ts';

describe('parseRmprOptions', () => {
  test('parses single --rmpr line with multiple options and returns cleaned comment', () => {
    const commentBody = 'Please fix this\n--rmpr include-all with-imports with-importers';
    const result = parseRmprOptions(commentBody);
    expect(result).toEqual({
      options: {
        includeAll: true,
        withImports: true,
        withImporters: true,
      },
      cleanedComment: 'Please fix this',
    });
  });

  test('parses multiple --rmpr lines and returns cleaned comment', () => {
    const commentBody = 'Please fix this\n--rmpr include-all\n--rmpr with-imports';
    const result = parseRmprOptions(commentBody);
    expect(result).toEqual({
      options: {
        includeAll: true,
        withImports: true,
      },
      cleanedComment: 'Please fix this',
    });
  });

  test('parses --rmpr include with multiple paths and returns cleaned comment', () => {
    const commentBody = 'Fix paths\n--rmpr include src/utils.ts,pr:*.ts';
    const result = parseRmprOptions(commentBody);
    expect(result).toEqual({
      options: {
        include: ['src/utils.ts', 'pr:*.ts'],
      },
      cleanedComment: 'Fix paths',
    });
  });

  test('parses --rmpr rmfilter with additional options and returns cleaned comment', () => {
    const commentBody = 'Filter files\n--rmpr rmfilter --grep example --exclude node_modules';
    const result = parseRmprOptions(commentBody);
    expect(result).toEqual({
      options: {
        rmfilter: ['--grep', 'example', '--exclude', 'node_modules'],
      },
      cleanedComment: 'Filter files',
    });
  });

  test('returns null options for comment with no --rmpr lines and full comment', () => {
    const commentBody = 'Just a regular comment';
    const result = parseRmprOptions(commentBody);
    expect(result).toEqual({
      options: null,
      cleanedComment: 'Just a regular comment',
    });
  });

  test('handles empty --rmpr line and returns cleaned comment', () => {
    const commentBody = '--rmpr \nSome other content';
    const result = parseRmprOptions(commentBody);
    expect(result).toEqual({
      options: null,
      cleanedComment: 'Some other content',
    });
  });

  test('parses mixed options with quoted paths and returns cleaned comment', () => {
    const commentBody =
      'Update imports\n--rmpr include "src/utils.ts"\nrmpr: with-imports\n--rmpr rmfilter "--grep example"';
    const result = parseRmprOptions(commentBody);
    expect(result).toEqual({
      options: {
        include: ['src/utils.ts'],
        withImports: true,
        rmfilter: ['--grep', 'example'],
      },
      cleanedComment: 'Update imports',
    });
  });
});
