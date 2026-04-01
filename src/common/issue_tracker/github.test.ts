import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { GitHubIssueTrackerClient, createGitHubClient } from './github.js';
import type {
  IssueTrackerClient,
  IssueTrackerConfig,
  IssueData,
  CommentData,
  IssueWithComments,
  ParsedIssueIdentifier,
} from './types.js';

// Mock the GitHub modules
vi.mock('../github/issues.js', () => ({
  fetchIssueAndComments: vi.fn(),
  fetchAllOpenIssues: vi.fn(),
  parseGitHubIssueIdentifier: vi.fn(),
}));

vi.mock('../github/identifiers.js', () => ({
  parsePrOrIssueNumber: vi.fn(),
}));

// Import mocked modules
import {
  fetchIssueAndComments,
  fetchAllOpenIssues,
  parseGitHubIssueIdentifier,
} from '../github/issues.js';
import { parsePrOrIssueNumber } from '../github/identifiers.js';

describe('GitHubIssueTrackerClient', () => {
  let client: GitHubIssueTrackerClient;
  let config: IssueTrackerConfig;

  // Mock GitHub API responses
  const mockIssue = {
    id: 123456789,
    number: 42,
    title: 'Add dark mode toggle',
    body: 'We need a dark mode toggle in the settings page.',
    html_url: 'https://github.com/owner/repo/issues/42',
    state: 'open',
    user: {
      id: 987654321,
      login: 'contributor',
      name: 'Jane Contributor',
      avatar_url: 'https://avatars.githubusercontent.com/u/987654321',
      email: 'jane@example.com',
    },
    assignees: [
      {
        id: 111222333,
        login: 'maintainer',
        name: 'John Maintainer',
        avatar_url: 'https://avatars.githubusercontent.com/u/111222333',
      },
    ],
    labels: [
      {
        id: 1001,
        name: 'enhancement',
        color: 'a2eeef',
      },
      {
        id: 1002,
        name: 'ui',
        color: 'fbca04',
      },
    ],
    created_at: '2024-01-15T10:30:00Z',
    updated_at: '2024-01-16T14:22:00Z',
    pull_request: null,
  };

  const mockComments = [
    {
      id: 98765432,
      body: 'Great idea! I think we should also consider system preference detection.',
      user: {
        id: 444555666,
        login: 'reviewer',
        name: 'Code Reviewer',
        avatar_url: 'https://avatars.githubusercontent.com/u/444555666',
      },
      created_at: '2024-01-16T09:15:00Z',
      updated_at: '2024-01-16T09:20:00Z',
      html_url: 'https://github.com/owner/repo/issues/42#issuecomment-98765432',
    },
    {
      id: 98765433,
      body: 'I can work on this feature.',
      user: {
        id: 777888999,
        login: 'volunteer',
        name: 'Helpful Volunteer',
        avatar_url: 'https://avatars.githubusercontent.com/u/777888999',
      },
      created_at: '2024-01-16T10:30:00Z',
      updated_at: null,
      html_url: 'https://github.com/owner/repo/issues/42#issuecomment-98765433',
    },
  ];

  const mockOpenIssues = [
    {
      id: 123456789,
      number: 42,
      title: 'Add dark mode toggle',
      body: 'We need a dark mode toggle.',
      html_url: 'https://github.com/owner/repo/issues/42',
      state: 'open',
      user: {
        id: 987654321,
        login: 'contributor',
        name: 'Jane Contributor',
        avatar_url: 'https://avatars.githubusercontent.com/u/987654321',
      },
      assignees: [],
      labels: [
        {
          id: 1001,
          name: 'enhancement',
          color: 'a2eeef',
        },
      ],
      created_at: '2024-01-15T10:30:00Z',
      updated_at: '2024-01-16T14:22:00Z',
      pull_request: null,
    },
    {
      id: 123456790,
      number: 43,
      title: 'Fix navbar responsiveness',
      body: 'The navbar is not responsive on mobile devices.',
      html_url: 'https://github.com/owner/repo/issues/43',
      state: 'open',
      user: {
        id: 111222333,
        login: 'maintainer',
        name: 'John Maintainer',
      },
      assignees: [
        {
          id: 444555666,
          login: 'developer',
          name: 'Lead Developer',
        },
      ],
      labels: [
        {
          id: 1003,
          name: 'bug',
          color: 'd73a4a',
        },
        {
          id: 1004,
          name: 'mobile',
          color: '0052cc',
        },
      ],
      created_at: '2024-01-17T08:45:00Z',
      updated_at: '2024-01-17T08:45:00Z',
      pull_request: null,
    },
  ];

  beforeEach(() => {
    config = {
      type: 'github',
      apiKey: 'ghp_test_token_12345',
    };
    client = new GitHubIssueTrackerClient(config);

    // Reset all mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.clearAllMocks();
  });

  describe('constructor and basic properties', () => {
    test('should create client with provided configuration', () => {
      expect(client).toBeInstanceOf(GitHubIssueTrackerClient);
      expect(client.getConfig()).toEqual(config);
      expect(client.getDisplayName()).toBe('GitHub');
    });

    test('should implement IssueTrackerClient interface', () => {
      const trackerClient: IssueTrackerClient = client;

      expect(typeof trackerClient.fetchIssue).toBe('function');
      expect(typeof trackerClient.fetchAllOpenIssues).toBe('function');
      expect(typeof trackerClient.parseIssueIdentifier).toBe('function');
      expect(typeof trackerClient.getDisplayName).toBe('function');
      expect(typeof trackerClient.getConfig).toBe('function');
    });
  });

  describe('createGitHubClient factory function', () => {
    test('should create GitHubIssueTrackerClient instance', () => {
      const factoryClient = createGitHubClient(config);

      expect(factoryClient).toBeInstanceOf(GitHubIssueTrackerClient);
      expect(factoryClient.getConfig()).toEqual(config);
      expect(factoryClient.getDisplayName()).toBe('GitHub');
    });

    test('should create different instances for different configs', () => {
      const config1 = { type: 'github' as const, apiKey: 'token1' };
      const config2 = { type: 'github' as const, apiKey: 'token2' };

      const client1 = createGitHubClient(config1);
      const client2 = createGitHubClient(config2);

      expect(client1).not.toBe(client2);
      expect(client1.getConfig().apiKey).toBe('token1');
      expect(client2.getConfig().apiKey).toBe('token2');
    });
  });

  describe('parseIssueIdentifier', () => {
    test('should parse GitHub URLs correctly', () => {
      const mockParseGitHubIssueIdentifier = vi.mocked(parseGitHubIssueIdentifier);

      const testCases = [
        {
          input: 'https://github.com/facebook/react/issues/123',
          expected: {
            identifier: '123',
            owner: 'facebook',
            repo: 'react',
            url: 'https://github.com/facebook/react/issues/123',
          },
        },
        {
          input: 'https://github.com/microsoft/vscode/pull/456',
          expected: {
            identifier: '456',
            owner: 'microsoft',
            repo: 'vscode',
            url: 'https://github.com/microsoft/vscode/pull/456',
          },
        },
        {
          input: 'https://github.com/a/b/issues/1',
          expected: {
            identifier: '1',
            owner: 'a',
            repo: 'b',
            url: 'https://github.com/a/b/issues/1',
          },
        },
      ];

      testCases.forEach(({ input, expected }) => {
        mockParseGitHubIssueIdentifier.mockReturnValue(expected);
        const result = client.parseIssueIdentifier(input);
        expect(result).toEqual(expected);
      });
    });

    test('should parse short format identifiers', () => {
      const mockParseGitHubIssueIdentifier = vi.mocked(parseGitHubIssueIdentifier);

      const testCases = [
        {
          input: 'owner/repo#123',
          expected: {
            identifier: '123',
            owner: 'owner',
            repo: 'repo',
          },
        },
        {
          input: 'facebook/react#456',
          expected: {
            identifier: '456',
            owner: 'facebook',
            repo: 'react',
          },
        },
        {
          input: 'a/b#1',
          expected: {
            identifier: '1',
            owner: 'a',
            repo: 'b',
          },
        },
      ];

      testCases.forEach(({ input, expected }) => {
        mockParseGitHubIssueIdentifier.mockReturnValue(expected);
        const result = client.parseIssueIdentifier(input);
        expect(result).toEqual(expected);
      });
    });

    test('should parse alternative short format identifiers', () => {
      const mockParseGitHubIssueIdentifier = vi.mocked(parseGitHubIssueIdentifier);

      const testCases = [
        {
          input: 'owner/repo/123',
          expected: {
            identifier: '123',
            owner: 'owner',
            repo: 'repo',
          },
        },
        {
          input: 'facebook/react/456',
          expected: {
            identifier: '456',
            owner: 'facebook',
            repo: 'react',
          },
        },
      ];

      testCases.forEach(({ input, expected }) => {
        mockParseGitHubIssueIdentifier.mockReturnValue(expected);
        const result = client.parseIssueIdentifier(input);
        expect(result).toEqual(expected);
      });
    });

    test('should parse simple number identifiers', () => {
      const mockParseGitHubIssueIdentifier = vi.mocked(parseGitHubIssueIdentifier);
      const testCases = ['123', '456', '1', '999999'];

      testCases.forEach((input) => {
        const expected = { identifier: input };
        mockParseGitHubIssueIdentifier.mockReturnValue(expected);
        const result = client.parseIssueIdentifier(input);
        expect(result).toEqual(expected);
      });
    });

    test('should handle invalid formats gracefully', () => {
      const mockParseGitHubIssueIdentifier = vi.mocked(parseGitHubIssueIdentifier);
      const invalidCases = [
        'invalid-format',
        'not/a#valid',
        'https://invalid-url',
        'owner/repo#abc', // non-numeric issue number
        'owner#123', // missing repo
        '',
        '   ', // whitespace only
      ];

      invalidCases.forEach((input) => {
        mockParseGitHubIssueIdentifier.mockReturnValue(null);
        const result = client.parseIssueIdentifier(input);
        expect(result).toBeNull();
      });
    });

    test('should handle whitespace in input', () => {
      const mockParseGitHubIssueIdentifier = vi.mocked(parseGitHubIssueIdentifier);

      const testCases = [
        {
          input: '  123  ',
          expected: { identifier: '123' },
        },
        {
          input: '\n\towner/repo#456\n\t',
          expected: {
            identifier: '456',
            owner: 'owner',
            repo: 'repo',
          },
        },
      ];

      testCases.forEach(({ input, expected }) => {
        mockParseGitHubIssueIdentifier.mockReturnValue(expected);
        const result = client.parseIssueIdentifier(input);
        expect(result).toEqual(expected);
      });
    });
  });

  describe('fetchIssue', () => {
    test('should successfully fetch issue with comments', async () => {
      // Mock the GitHub functions
      const mockFetchIssueAndComments = vi.mocked(fetchIssueAndComments);
      const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);

      mockParsePrOrIssueNumber.mockResolvedValue({
        owner: 'owner',
        repo: 'repo',
        number: 42,
      });

      mockFetchIssueAndComments.mockResolvedValue({
        issue: mockIssue,
        comments: mockComments,
      });

      const result = await client.fetchIssue('42');

      // Verify the structure
      expect(result.issue).toBeDefined();
      expect(result.comments).toBeDefined();
      expect(Array.isArray(result.comments)).toBe(true);

      // Verify issue mapping
      const { issue } = result;
      expect(issue.id).toBe('123456789');
      expect(issue.number).toBe(42);
      expect(issue.title).toBe('Add dark mode toggle');
      expect(issue.body).toBe('We need a dark mode toggle in the settings page.');
      expect(issue.htmlUrl).toBe('https://github.com/owner/repo/issues/42');
      expect(issue.state).toBe('open');
      expect(issue.pullRequest).toBe(false);

      // Verify user mapping
      expect(issue.user?.id).toBe('987654321');
      expect(issue.user?.login).toBe('contributor');
      expect(issue.user?.name).toBe('Jane Contributor');
      expect(issue.user?.avatarUrl).toBe('https://avatars.githubusercontent.com/u/987654321');
      expect(issue.user?.email).toBe('jane@example.com');

      // Verify assignees mapping
      expect(issue.assignees).toHaveLength(1);
      expect(issue.assignees?.[0].id).toBe('111222333');
      expect(issue.assignees?.[0].login).toBe('maintainer');
      expect(issue.assignees?.[0].name).toBe('John Maintainer');

      // Verify labels mapping
      expect(issue.labels).toHaveLength(2);
      expect(issue.labels?.[0]).toEqual({
        id: '1001',
        name: 'enhancement',
        color: 'a2eeef',
      });
      expect(issue.labels?.[1]).toEqual({
        id: '1002',
        name: 'ui',
        color: 'fbca04',
      });

      // Verify dates
      expect(issue.createdAt).toBe('2024-01-15T10:30:00Z');
      expect(issue.updatedAt).toBe('2024-01-16T14:22:00Z');

      // Verify comments mapping
      expect(result.comments).toHaveLength(2);

      const comment1 = result.comments[0];
      expect(comment1.id).toBe('98765432');
      expect(comment1.body).toBe(
        'Great idea! I think we should also consider system preference detection.'
      );
      expect(comment1.user?.login).toBe('reviewer');
      expect(comment1.createdAt).toBe('2024-01-16T09:15:00Z');
      expect(comment1.updatedAt).toBe('2024-01-16T09:20:00Z');
      expect(comment1.htmlUrl).toBe(
        'https://github.com/owner/repo/issues/42#issuecomment-98765432'
      );

      const comment2 = result.comments[1];
      expect(comment2.id).toBe('98765433');
      expect(comment2.body).toBe('I can work on this feature.');
      expect(comment2.user?.login).toBe('volunteer');
      expect(comment2.createdAt).toBe('2024-01-16T10:30:00Z');
      expect(comment2.updatedAt).toBeUndefined();
      expect(comment2.htmlUrl).toBe(
        'https://github.com/owner/repo/issues/42#issuecomment-98765433'
      );
    });

    test('should handle issue with no body', async () => {
      const issueNoBody = { ...mockIssue, body: null };
      const mockFetchIssueAndComments = vi.mocked(fetchIssueAndComments);
      const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);

      mockParsePrOrIssueNumber.mockResolvedValue({
        owner: 'owner',
        repo: 'repo',
        number: 42,
      });

      mockFetchIssueAndComments.mockResolvedValue({
        issue: issueNoBody,
        comments: [],
      });

      const result = await client.fetchIssue('42');

      expect(result.issue.body).toBeUndefined();
    });

    test('should handle issue with no user', async () => {
      const issueNoUser = { ...mockIssue, user: null };
      const mockFetchIssueAndComments = vi.mocked(fetchIssueAndComments);
      const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);

      mockParsePrOrIssueNumber.mockResolvedValue({
        owner: 'owner',
        repo: 'repo',
        number: 42,
      });

      mockFetchIssueAndComments.mockResolvedValue({
        issue: issueNoUser,
        comments: [],
      });

      const result = await client.fetchIssue('42');

      expect(result.issue.user).toBeUndefined();
    });

    test('should handle issue with empty arrays', async () => {
      const issueEmptyArrays = {
        ...mockIssue,
        assignees: [],
        labels: [],
      };
      const mockFetchIssueAndComments = vi.mocked(fetchIssueAndComments);
      const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);

      mockParsePrOrIssueNumber.mockResolvedValue({
        owner: 'owner',
        repo: 'repo',
        number: 42,
      });

      mockFetchIssueAndComments.mockResolvedValue({
        issue: issueEmptyArrays,
        comments: [],
      });

      const result = await client.fetchIssue('42');

      expect(result.issue.assignees).toBeUndefined();
      expect(result.issue.labels).toBeUndefined();
    });

    test('should handle pull requests', async () => {
      const pullRequest = {
        ...mockIssue,
        pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/42' },
      };
      const mockFetchIssueAndComments = vi.mocked(fetchIssueAndComments);
      const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);

      mockParsePrOrIssueNumber.mockResolvedValue({
        owner: 'owner',
        repo: 'repo',
        number: 42,
      });

      mockFetchIssueAndComments.mockResolvedValue({
        issue: pullRequest,
        comments: [],
      });

      const result = await client.fetchIssue('42');

      expect(result.issue.pullRequest).toBe(true);
    });

    test('should handle invalid identifier', async () => {
      const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
      mockParsePrOrIssueNumber.mockResolvedValue(null);

      await expect(client.fetchIssue('invalid')).rejects.toThrow(
        'Invalid GitHub issue identifier: invalid'
      );
    });

    test('should handle GitHub API errors', async () => {
      const mockFetchIssueAndComments = vi.mocked(fetchIssueAndComments);
      const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);

      mockParsePrOrIssueNumber.mockResolvedValue({
        owner: 'owner',
        repo: 'repo',
        number: 42,
      });

      mockFetchIssueAndComments.mockRejectedValue(new Error('API rate limit exceeded'));

      await expect(client.fetchIssue('42')).rejects.toThrow(
        'Failed to fetch GitHub issue #42: API rate limit exceeded'
      );
    });

    test('should handle comment with no body', async () => {
      const commentNoBody = { ...mockComments[0], body: null };
      const mockFetchIssueAndComments = vi.mocked(fetchIssueAndComments);
      const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);

      mockParsePrOrIssueNumber.mockResolvedValue({
        owner: 'owner',
        repo: 'repo',
        number: 42,
      });

      mockFetchIssueAndComments.mockResolvedValue({
        issue: mockIssue,
        comments: [commentNoBody],
      });

      const result = await client.fetchIssue('42');

      expect(result.comments[0].body).toBe('');
    });

    test('should handle comment with no user', async () => {
      const commentNoUser = { ...mockComments[0], user: null };
      const mockFetchIssueAndComments = vi.mocked(fetchIssueAndComments);
      const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);

      mockParsePrOrIssueNumber.mockResolvedValue({
        owner: 'owner',
        repo: 'repo',
        number: 42,
      });

      mockFetchIssueAndComments.mockResolvedValue({
        issue: mockIssue,
        comments: [commentNoUser],
      });

      const result = await client.fetchIssue('42');

      expect(result.comments[0].user).toBeUndefined();
    });
  });

  describe('fetchAllOpenIssues', () => {
    test('should successfully fetch all open issues', async () => {
      const mockFetchAllOpenIssues = vi.mocked(fetchAllOpenIssues);
      mockFetchAllOpenIssues.mockResolvedValue(mockOpenIssues);

      const result = await client.fetchAllOpenIssues();

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);

      // Verify first issue
      const issue1 = result[0];
      expect(issue1.id).toBe('123456789');
      expect(issue1.number).toBe(42);
      expect(issue1.title).toBe('Add dark mode toggle');
      expect(issue1.state).toBe('open');
      expect(issue1.pullRequest).toBe(false);

      // Verify second issue
      const issue2 = result[1];
      expect(issue2.id).toBe('123456790');
      expect(issue2.number).toBe(43);
      expect(issue2.title).toBe('Fix navbar responsiveness');
      expect(issue2.assignees).toHaveLength(1);
      expect(issue2.labels).toHaveLength(2);
    });

    test('should handle empty issues list', async () => {
      const mockFetchAllOpenIssues = vi.mocked(fetchAllOpenIssues);
      mockFetchAllOpenIssues.mockResolvedValue([]);

      const result = await client.fetchAllOpenIssues();

      expect(result).toEqual([]);
    });

    test('should handle GitHub API errors', async () => {
      const mockFetchAllOpenIssues = vi.mocked(fetchAllOpenIssues);
      mockFetchAllOpenIssues.mockRejectedValue(new Error('Repository not found'));

      await expect(client.fetchAllOpenIssues()).rejects.toThrow(
        'Failed to fetch open GitHub issues: Repository not found'
      );
    });

    test('should handle issues without optional fields', async () => {
      const minimalIssue = {
        id: 123,
        number: 1,
        title: 'Minimal Issue',
        body: null,
        html_url: 'https://github.com/owner/repo/issues/1',
        state: 'open',
        user: null,
        assignees: null,
        labels: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        pull_request: null,
      };

      const mockFetchAllOpenIssues = vi.mocked(fetchAllOpenIssues);
      mockFetchAllOpenIssues.mockResolvedValue([minimalIssue]);

      const result = await client.fetchAllOpenIssues();

      expect(result).toHaveLength(1);
      expect(result[0].body).toBeUndefined();
      expect(result[0].user).toBeUndefined();
      expect(result[0].assignees).toBeUndefined();
      expect(result[0].labels).toBeUndefined();
      expect(result[0].pullRequest).toBe(false);
    });
  });

  describe('data mapping edge cases', () => {
    test('should handle user without name (uses login as name)', async () => {
      const userNoName = { ...mockIssue.user, name: null };
      const issueUserNoName = { ...mockIssue, user: userNoName };
      const mockFetchIssueAndComments = vi.mocked(fetchIssueAndComments);
      const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);

      mockParsePrOrIssueNumber.mockResolvedValue({
        owner: 'owner',
        repo: 'repo',
        number: 42,
      });

      mockFetchIssueAndComments.mockResolvedValue({
        issue: issueUserNoName,
        comments: [],
      });

      const result = await client.fetchIssue('42');

      expect(result.issue.user?.name).toBe('contributor'); // Should use login
    });

    test('should handle labels without color', async () => {
      const labelNoColor = { id: 1001, name: 'no-color', color: null };
      const issueWithLabelNoColor = {
        ...mockIssue,
        labels: [labelNoColor],
      };
      const mockFetchIssueAndComments = vi.mocked(fetchIssueAndComments);
      const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);

      mockParsePrOrIssueNumber.mockResolvedValue({
        owner: 'owner',
        repo: 'repo',
        number: 42,
      });

      mockFetchIssueAndComments.mockResolvedValue({
        issue: issueWithLabelNoColor,
        comments: [],
      });

      const result = await client.fetchIssue('42');

      expect(result.issue.labels?.[0]).toEqual({
        id: '1001',
        name: 'no-color',
        color: undefined,
      });
    });

    test('should convert all IDs to strings', async () => {
      const largeNumberIds = {
        ...mockIssue,
        id: Number.MAX_SAFE_INTEGER,
        user: {
          ...mockIssue.user,
          id: Number.MAX_SAFE_INTEGER - 1,
        },
        assignees: [
          {
            id: Number.MAX_SAFE_INTEGER - 2,
            login: 'test',
            name: 'Test User',
          },
        ],
        labels: [
          {
            id: Number.MAX_SAFE_INTEGER - 3,
            name: 'test-label',
            color: 'ffffff',
          },
        ],
      };
      const mockFetchIssueAndComments = vi.mocked(fetchIssueAndComments);
      const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);

      mockParsePrOrIssueNumber.mockResolvedValue({
        owner: 'owner',
        repo: 'repo',
        number: 42,
      });

      mockFetchIssueAndComments.mockResolvedValue({
        issue: largeNumberIds,
        comments: [],
      });

      const result = await client.fetchIssue('42');

      expect(typeof result.issue.id).toBe('string');
      expect(result.issue.id).toBe(Number.MAX_SAFE_INTEGER.toString());
      expect(typeof result.issue.user?.id).toBe('string');
      expect(typeof result.issue.assignees?.[0].id).toBe('string');
      expect(typeof result.issue.labels?.[0].id).toBe('string');
    });
  });

  describe('error handling', () => {
    test('should handle non-Error exceptions', async () => {
      const mockFetchIssueAndComments = vi.mocked(fetchIssueAndComments);
      const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);

      mockParsePrOrIssueNumber.mockResolvedValue({
        owner: 'owner',
        repo: 'repo',
        number: 42,
      });

      mockFetchIssueAndComments.mockRejectedValue('String error'); // Non-Error object

      await expect(client.fetchIssue('42')).rejects.toThrow(
        'Failed to fetch GitHub issue #42: String error'
      );
    });

    test('should handle fetchAllOpenIssues with non-Error exceptions', async () => {
      const mockFetchAllOpenIssues = vi.mocked(fetchAllOpenIssues);
      mockFetchAllOpenIssues.mockRejectedValue({ message: 'Object error', code: 404 }); // Non-Error object

      await expect(client.fetchAllOpenIssues()).rejects.toThrow(
        'Failed to fetch open GitHub issues: [object Object]'
      );
    });
  });

  describe('integration with factory', () => {
    test('should work correctly when created through factory', () => {
      const factoryClient = createGitHubClient({
        type: 'github',
        apiKey: 'factory_token',
        baseUrl: 'https://api.github.com',
        options: { userAgent: 'test-app/1.0.0' },
      });

      expect(factoryClient).toBeInstanceOf(GitHubIssueTrackerClient);
      expect(factoryClient.getDisplayName()).toBe('GitHub');

      const factoryConfig = factoryClient.getConfig();
      expect(factoryConfig.type).toBe('github');
      expect(factoryConfig.apiKey).toBe('factory_token');
      expect(factoryConfig.baseUrl).toBe('https://api.github.com');
      expect(factoryConfig.options).toEqual({ userAgent: 'test-app/1.0.0' });
    });
  });
});
