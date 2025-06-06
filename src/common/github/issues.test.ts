import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { getInstructionsFromGithubIssue, fetchAllOpenIssues } from './issues.ts';
import * as logging from '../../logging.ts';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('getInstructionsFromGithubIssue', () => {
  afterEach(() => {
    // Clean up mocks
    moduleMocker.clear();
  });

  test('parses and combines RmprOptions from issue body and comments', async () => {
    // Mock the issues.ts module
    await moduleMocker.mock('./issues.ts', () => ({
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
    await moduleMocker.mock('./issues.ts', () => ({
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

describe('fetchAllOpenIssues', () => {
  afterEach(() => {
    moduleMocker.clear();
  });

  test('fetches all open issues for current repository', async () => {
    const mockIssues = [
      { number: 1, title: 'First Issue', body: 'First issue body' },
      { number: 2, title: 'Second Issue', body: 'Second issue body' },
    ];

    // Mock the git module
    await moduleMocker.mock('../git.ts', () => ({
      getGitRepository: async () => 'testowner/testrepo',
    }));

    // Mock the Octokit paginate method
    const mockPaginate = mock(async () => mockIssues);

    // Mock the issues.ts module
    await moduleMocker.mock('./issues.ts', () => ({
      fetchAllOpenIssues,
      fetchIssueAndComments: async () => ({}),
    }));

    // Mock Octokit
    await moduleMocker.mock('octokit', () => ({
      Octokit: mock(function () {
        return {
          paginate: mockPaginate,
          rest: {
            issues: {
              listForRepo: mock(),
            },
          },
        };
      }),
    }));

    const result = await fetchAllOpenIssues();

    expect(result).toEqual(mockIssues);
    expect(mockPaginate).toHaveBeenCalledWith(expect.any(Function), {
      owner: 'testowner',
      repo: 'testrepo',
      state: 'open',
    });
  });

  test('throws error for invalid repository format', async () => {
    // Mock the git module to return invalid format
    await moduleMocker.mock('../git.ts', () => ({
      getGitRepository: async () => 'invalid-format',
    }));

    // Mock the issues.ts module
    await moduleMocker.mock('./issues.ts', () => ({
      fetchAllOpenIssues,
    }));

    await expect(fetchAllOpenIssues()).rejects.toThrow('Invalid repository format: invalid-format');
  });
});
