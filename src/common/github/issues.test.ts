import { describe, test, expect, mock, spyOn } from 'bun:test';
import { getInstructionsFromGithubIssue } from './issues.ts';
import * as logging from '../../logging.ts';
import { parseRmprOptions } from '../../rmpr/comment_options.ts';

describe('getInstructionsFromGithubIssue', () => {
  test('parses and combines RmprOptions from issue body and comments', async () => {
    // Mock the issues.ts module
    await mock.module('./issues.ts', () => ({
      getInstructionsFromGithubIssue,
      fetchIssueAndComments: async () => ({
        issue: {
          number: 123,
          title: 'Test Issue',
          body: 'Issue body\n--rmpr include-all with-imports',
        },
        comments: [
          { body: 'Comment 1\n--rmpr with-importers' },
          { body: 'Comment 2\n--rmpr include src/utils.ts' },
        ],
      }),
      selectIssueComments: async () => ['Issue body', 'Comment 1', 'Comment 2'],
      parsePrOrIssueNumber: () => ({ owner: 'test', repo: 'repo', number: 123 }),
    }));

    // Spy on console.log to suppress output
    const logSpy = spyOn(logging, 'log').mockImplementation(() => {});

    try {
      const result = await getInstructionsFromGithubIssue('123');

      expect(result.rmprOptions).toEqual({
        includeAll: true,
        withImports: true,
        withImporters: true,
        include: ['src/utils.ts'],
        rmfilter: [],
      });

      expect(result.plan).toBe('Issue body\n\nComment 1\n\nComment 2');
      expect(result.suggestedFileName).toBe('issue-123-test-issue.md');
    } finally {
      logSpy.mockRestore();
    }
  });

  test('handles issue with no RmprOptions', async () => {
    // Mock the issues.ts module
    await mock.module('./issues.ts', () => ({
      getInstructionsFromGithubIssue,
      fetchIssueAndComments: async () => ({
        issue: {
          number: 123,
          title: 'Test Issue',
          body: 'Issue body',
        },
        comments: [{ body: 'Comment 1' }],
      }),
      selectIssueComments: async () => ['Issue body', 'Comment 1'],
      parsePrOrIssueNumber: () => ({ owner: 'test', repo: 'repo', number: 123 }),
    }));

    // Spy on console.log to suppress output
    const logSpy = spyOn(logging, 'log').mockImplementation(() => {});

    try {
      const result = await getInstructionsFromGithubIssue('123');

      expect(result.rmprOptions).toBeNull();
      expect(result.plan).toBe('Issue body\n\nComment 1');
      expect(result.suggestedFileName).toBe('issue-123-test-issue.md');
    } finally {
      logSpy.mockRestore();
    }
  });
});
