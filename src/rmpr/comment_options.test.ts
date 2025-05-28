import { describe, test, expect, spyOn } from 'bun:test';
import { parseCommandOptionsFromComment, argsFromRmprOptions } from './comment_options.ts';
import * as logging from '../logging.ts';
import type { PullRequest } from '../common/github/pull_requests.ts';

describe('parseCommandOptionsFromComment', () => {
  test('parses single --rmpr line with multiple options and returns cleaned comment', () => {
    const commentBody = 'Please fix this\n--rmpr include-all with-imports with-importers';
    const result = parseCommandOptionsFromComment(commentBody);
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
    const result = parseCommandOptionsFromComment(commentBody);
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
    const result = parseCommandOptionsFromComment(commentBody);
    expect(result).toEqual({
      options: {
        include: ['src/utils.ts', 'pr:*.ts'],
      },
      cleanedComment: 'Fix paths',
    });
  });

  test('parses --rmpr rmfilter with additional options and returns cleaned comment', () => {
    const commentBody = 'Filter files\n--rmpr rmfilter --grep example --exclude node_modules';
    const result = parseCommandOptionsFromComment(commentBody);
    expect(result).toEqual({
      options: {
        rmfilter: ['--', '--grep', 'example', '--exclude', 'node_modules'],
      },
      cleanedComment: 'Filter files',
    });
  });

  test('returns null options for comment with no --rmpr lines and full comment', () => {
    const commentBody = 'Just a regular comment';
    const result = parseCommandOptionsFromComment(commentBody);
    expect(result).toEqual({
      options: null,
      cleanedComment: 'Just a regular comment',
    });
  });

  test('handles empty --rmpr line and returns cleaned comment', () => {
    const commentBody = '--rmpr \nSome other content';
    const result = parseCommandOptionsFromComment(commentBody);
    expect(result).toEqual({
      options: null,
      cleanedComment: 'Some other content',
    });
  });

  test('parses mixed options with quoted paths and returns cleaned comment', () => {
    const commentBody =
      'Update imports\n--rmpr include "src/utils.ts"\nrmpr: with-imports\n--rmpr rmfilter "--grep example"';
    const result = parseCommandOptionsFromComment(commentBody);
    expect(result).toEqual({
      options: {
        include: ['src/utils.ts'],
        withImports: true,
        rmfilter: ['--', '--grep', 'example'],
      },
      cleanedComment: 'Update imports',
    });
  });
});

describe('argsFromRmprOptions', () => {
  test('includes standard options without PR', () => {
    const options = {
      withImports: true,
      withImporters: true,
      include: ['src/file.ts', 'lib/*.js'],
      rmfilter: ['--grep', 'example', '--exclude', 'node_modules'],
    };

    const args = argsFromRmprOptions(options);
    expect(args).toEqual([
      '--with-imports',
      '--with-importers',
      'src/file.ts',
      'lib/*.js',
      '--grep',
      'example',
      '--exclude',
      'node_modules',
    ]);
  });

  test('skips PR-specific options with warnings when no PR provided', () => {
    // Spy on warn function
    const warnSpy = spyOn(logging, 'warn');

    const options = {
      includeAll: true,
      withImports: true,
      include: ['pr:src/file.ts', 'lib/*.js'],
    };

    const args = argsFromRmprOptions(options);

    // Should skip PR-specific paths and the includeAll option
    expect(args).toEqual(['--with-imports', 'lib/*.js']);

    // Check that appropriate warnings were issued
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      'Skipping PR-specific include directive in generic context: pr:src/file.ts'
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'Skipping PR-specific "include-all" directive in generic context.'
    );
  });

  test('handles empty options without PR', () => {
    const options = {};
    const args = argsFromRmprOptions(options);
    expect(args).toEqual([]);
  });

  test('includes PR-specific options when PR is provided', () => {
    const pr: PullRequest = {
      files: {
        nodes: [{ path: 'src/file1.ts' }, { path: 'src/file2.ts' }],
      },
    } as PullRequest;

    const options = {
      includeAll: true,
      withImports: true,
      include: ['pr:src/*.ts', 'lib/*.js'],
    };

    const args = argsFromRmprOptions(options, pr).sort();
    expect(args).toEqual(['--with-imports', 'src/file1.ts', 'src/file2.ts', 'lib/*.js'].sort());
  });
});
