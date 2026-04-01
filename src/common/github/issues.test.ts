import { describe, test, expect, vi, spyOn, beforeEach, afterEach } from 'vitest';
import { getInstructionsFromGithubIssue, fetchAllOpenIssues } from './issues.ts';
import * as logging from '../../logging.ts';
import * as issuesModule from './issues.ts';
import * as gitModule from '../git.ts';
import * as octokitModule from './octokit.js';

// Mock the modules
vi.mock('./issues.ts', () => ({
  getInstructionsFromGithubIssue: vi.fn(),
  fetchAllOpenIssues: vi.fn(),
}));

vi.mock('../git.ts', () => ({
  getGitRoot: vi.fn(),
}));

vi.mock('./octokit.js', () => ({
  getOctokit: vi.fn(),
}));

describe('getInstructionsFromGithubIssue', () => {
  afterEach(() => {
    // Clean up mocks
    vi.restoreAllMocks();
  });

  test('parses and combines RmprOptions from issue body and comments', async () => {
    const fetchedIssue = {
      issue: {
        number: 123,
        title: 'Test Issue',
        body: 'Issue body\n--rmpr include-all with-imports',
      },
      comments: [
        { body: 'Comment 1\n--rmpr with-importers' },
        { body: 'Comment 2\n--rmpr include src/utils.ts' },
      ],
    };

    // Mock the issues.ts module
    const mockFetchIssueAndComments = vi.fn(async () => fetchedIssue);
    const mockSelectIssueComments = vi.fn(async () => ['Issue body', 'Comment 1', 'Comment 2']);
    const mockParsePrOrIssueNumber = vi.fn(() => ({ owner: 'test', repo: 'repo', number: 123 }));
    const mockGetInstructionsFromGithubIssue = vi.fn(async (issue) => ({
      rmprOptions: {
        includeAll: true,
        withImports: true,
        withImporters: true,
        include: ['src/utils.ts'],
        rmfilter: [],
      },
      plan: 'Issue body\n\nComment 1\n\nComment 2',
      suggestedFileName: 'issue-123-test-issue.md',
    }));
    const mockIssuesModule = vi.mocked(issuesModule);
    mockIssuesModule.fetchIssueAndComments = mockFetchIssueAndComments;
    mockIssuesModule.selectIssueComments = mockSelectIssueComments;
    mockIssuesModule.parsePrOrIssueNumber = mockParsePrOrIssueNumber;
    mockIssuesModule.getInstructionsFromGithubIssue = mockGetInstructionsFromGithubIssue;

    // Spy on console.log to suppress output
    const logSpy = vi.spyOn(logging, 'log').mockImplementation(() => {});

    try {
      const result = await getInstructionsFromGithubIssue(fetchedIssue);

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
    const fetchedIssue = {
      issue: {
        number: 123,
        title: 'Test Issue',
        body: 'Issue body',
      },
      comments: [{ body: 'Comment 1' }],
    };

    // Mock the issues.ts module
    const mockFetchIssueAndComments = vi.fn(async () => fetchedIssue);
    const mockSelectIssueComments = vi.fn(async () => ['Issue body', 'Comment 1']);
    const mockParsePrOrIssueNumber = vi.fn(() => ({ owner: 'test', repo: 'repo', number: 123 }));
    const mockIssuesModule = vi.mocked(issuesModule);
    mockIssuesModule.fetchIssueAndComments = mockFetchIssueAndComments;
    mockIssuesModule.selectIssueComments = mockSelectIssueComments;
    mockIssuesModule.parsePrOrIssueNumber = mockParsePrOrIssueNumber;

    // Override the mock for this specific test to return null
    mockIssuesModule.getInstructionsFromGithubIssue = vi.fn(async (issue) => null);

    // Spy on console.log to suppress output
    const logSpy = vi.spyOn(logging, 'log').mockImplementation(() => {});

    try {
      const result = await getInstructionsFromGithubIssue(fetchedIssue);

      expect(result).toBeNull();
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('fetchAllOpenIssues', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('fetches all open issues for current repository', async () => {
    const mockIssues = [
      { number: 1, title: 'First Issue', body: 'First issue body' },
      { number: 2, title: 'Second Issue', body: 'Second issue body' },
    ];

    // Mock the git module
    const mockGetGitRepository = vi.fn(async () => 'testowner/testrepo');
    const mockGitModule = vi.mocked(gitModule);
    mockGitModule.getGitRepository = mockGetGitRepository;

    // Mock the Octokit paginate method
    const mockPaginate = vi.fn(async () => mockIssues);

    // Mock the issues.ts module
    const mockIssuesModule2 = vi.mocked(issuesModule);
    mockIssuesModule2.fetchAllOpenIssues = vi.fn().mockResolvedValue(mockIssues);
    mockIssuesModule2.fetchIssueAndComments = vi.fn(async () => ({}));

    // Mock Octokit
    const mockGetOctokit = vi.mocked(octokitModule.getOctokit);
    mockGetOctokit.mockReturnValue({
      paginate: mockPaginate,
      rest: {
        issues: {
          listForRepo: vi.fn(),
        },
      },
    });

    const result = await mockIssuesModule2.fetchAllOpenIssues();

    expect(result).toEqual(mockIssues);
  });

  test('throws error for invalid repository format', async () => {
    // Mock the git module to return invalid format
    const mockGetGitRepository = vi.fn(async () => 'invalid-format');
    const mockGitModule = vi.mocked(gitModule);
    mockGitModule.getGitRepository = mockGetGitRepository;

    // Mock the issues.ts module
    const mockFetchAllOpenIssues = vi.fn(async () => {
      throw new Error('Invalid repository format: invalid-format');
    });
    const mockIssuesModule = vi.mocked(issuesModule);
    mockIssuesModule.fetchAllOpenIssues = mockFetchAllOpenIssues;

    await expect(mockFetchAllOpenIssues()).rejects.toThrow(
      'Invalid repository format: invalid-format'
    );
  });
});
