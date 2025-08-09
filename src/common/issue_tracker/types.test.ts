import { describe, test, expect } from 'bun:test';
import type {
  IssueData,
  CommentData,
  IssueWithComments,
  UserData,
  ParsedIssueIdentifier,
  IssueTrackerConfig,
  IssueTrackerClient,
} from './types.ts';

describe('Issue Tracker Types', () => {
  describe('GitHub data compatibility', () => {
    test('IssueData works with GitHub issue format', () => {
      // Sample GitHub issue data (simplified)
      const githubIssue: IssueData = {
        id: '123456789',
        number: 42,
        title: 'Add dark mode toggle',
        body: 'We need a dark mode toggle in the settings.',
        htmlUrl: 'https://github.com/owner/repo/issues/42',
        state: 'open',
        user: {
          id: '987654321',
          login: 'contributor',
          name: 'Jane Contributor',
          avatarUrl: 'https://avatars.githubusercontent.com/u/987654321',
        },
        assignees: [
          {
            id: '111222333',
            login: 'maintainer',
            name: 'John Maintainer',
          },
        ],
        labels: [
          {
            id: 'label1',
            name: 'enhancement',
            color: 'a2eeef',
          },
          {
            id: 'label2',
            name: 'ui',
            color: 'fbca04',
          },
        ],
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-16T14:22:00Z',
        pullRequest: false,
      };

      // Type assertions to ensure the interface is working
      expect(githubIssue.id).toBe('123456789');
      expect(githubIssue.number).toBe(42);
      expect(githubIssue.title).toBe('Add dark mode toggle');
      expect(githubIssue.htmlUrl).toBe('https://github.com/owner/repo/issues/42');
      expect(githubIssue.user?.login).toBe('contributor');
      expect(githubIssue.assignees).toHaveLength(1);
      expect(githubIssue.labels).toHaveLength(2);
    });

    test('CommentData works with GitHub comment format', () => {
      const githubComment: CommentData = {
        id: 'comment123',
        body: 'Great idea! I think we should also consider system preference detection.',
        user: {
          id: '444555666',
          login: 'reviewer',
          name: 'Code Reviewer',
          avatarUrl: 'https://avatars.githubusercontent.com/u/444555666',
        },
        createdAt: '2024-01-16T09:15:00Z',
        updatedAt: '2024-01-16T09:20:00Z',
        htmlUrl: 'https://github.com/owner/repo/issues/42#issuecomment-123',
      };

      expect(githubComment.id).toBe('comment123');
      expect(githubComment.body).toContain('system preference');
      expect(githubComment.user?.login).toBe('reviewer');
      expect(githubComment.htmlUrl).toContain('#issuecomment-123');
    });

    test('IssueWithComments works with GitHub data', () => {
      const githubIssueWithComments: IssueWithComments = {
        issue: {
          id: '123456789',
          number: 42,
          title: 'Add dark mode toggle',
          body: 'We need a dark mode toggle in the settings.',
          htmlUrl: 'https://github.com/owner/repo/issues/42',
          state: 'open',
          createdAt: '2024-01-15T10:30:00Z',
          updatedAt: '2024-01-16T14:22:00Z',
        },
        comments: [
          {
            id: 'comment123',
            body: 'Great idea!',
            user: { id: '444', login: 'reviewer' },
            createdAt: '2024-01-16T09:15:00Z',
          },
          {
            id: 'comment124',
            body: 'I can work on this.',
            user: { id: '555', login: 'volunteer' },
            createdAt: '2024-01-16T10:30:00Z',
          },
        ],
      };

      expect(githubIssueWithComments.issue.number).toBe(42);
      expect(githubIssueWithComments.comments).toHaveLength(2);
      expect(githubIssueWithComments.comments[0].body).toBe('Great idea!');
      expect(githubIssueWithComments.comments[1].user?.login).toBe('volunteer');
    });
  });

  describe('Linear data compatibility', () => {
    test('IssueData works with Linear issue format', () => {
      const linearIssue: IssueData = {
        id: 'linear_uuid_12345',
        number: 'TEAM-123', // Linear uses alphanumeric keys
        title: 'Implement user authentication',
        body: 'Add OAuth 2.0 authentication with Google and GitHub providers.',
        htmlUrl: 'https://linear.app/company/issue/TEAM-123/implement-user-authentication',
        state: 'In Progress',
        user: {
          id: 'user_uuid_67890',
          name: 'Product Manager',
          email: 'pm@company.com',
          avatarUrl: 'https://avatars.linear.app/user_uuid_67890',
        },
        assignees: [
          {
            id: 'dev_uuid_11111',
            name: 'Lead Developer',
            email: 'lead@company.com',
          },
        ],
        labels: [
          {
            id: 'label_uuid_22222',
            name: 'Feature',
            color: '#3b82f6',
          },
          {
            id: 'label_uuid_33333',
            name: 'Backend',
            color: '#ef4444',
          },
        ],
        createdAt: '2024-01-20T08:00:00Z',
        updatedAt: '2024-01-22T16:45:00Z',
        pullRequest: false,
      };

      expect(linearIssue.id).toBe('linear_uuid_12345');
      expect(linearIssue.number).toBe('TEAM-123');
      expect(linearIssue.title).toBe('Implement user authentication');
      expect(linearIssue.htmlUrl).toContain('linear.app');
      expect(linearIssue.user?.email).toBe('pm@company.com');
      expect(linearIssue.state).toBe('In Progress');
    });

    test('CommentData works with Linear comment format', () => {
      const linearComment: CommentData = {
        id: 'comment_uuid_44444',
        body: 'I suggest we start with Google OAuth as it has better documentation.',
        user: {
          id: 'dev_uuid_55555',
          name: 'Senior Developer',
          email: 'senior@company.com',
        },
        createdAt: '2024-01-21T12:30:00Z',
        updatedAt: '2024-01-21T12:35:00Z',
      };

      expect(linearComment.id).toBe('comment_uuid_44444');
      expect(linearComment.body).toContain('Google OAuth');
      expect(linearComment.user?.name).toBe('Senior Developer');
      expect(linearComment.user?.email).toBe('senior@company.com');
    });

    test('IssueWithComments works with Linear data', () => {
      const linearIssueWithComments: IssueWithComments = {
        issue: {
          id: 'linear_uuid_12345',
          number: 'TEAM-123',
          title: 'Implement user authentication',
          body: 'Add OAuth 2.0 authentication.',
          htmlUrl: 'https://linear.app/company/issue/TEAM-123',
          state: 'In Progress',
          createdAt: '2024-01-20T08:00:00Z',
          updatedAt: '2024-01-22T16:45:00Z',
        },
        comments: [
          {
            id: 'comment_uuid_44444',
            body: 'Starting with Google OAuth first.',
            user: { id: 'dev1', name: 'Dev One' },
            createdAt: '2024-01-21T12:30:00Z',
          },
        ],
      };

      expect(linearIssueWithComments.issue.number).toBe('TEAM-123');
      expect(linearIssueWithComments.comments).toHaveLength(1);
      expect(linearIssueWithComments.comments[0].body).toContain('Google OAuth');
    });
  });

  describe('Mixed number formats', () => {
    test('IssueData accepts both string and numeric numbers', () => {
      const numericNumber: IssueData = {
        id: '1',
        number: 42, // Numeric (GitHub style)
        title: 'Test',
        htmlUrl: 'https://example.com',
        state: 'open',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const stringNumber: IssueData = {
        id: '2',
        number: 'PROJ-456', // String (Linear style)
        title: 'Test',
        htmlUrl: 'https://example.com',
        state: 'open',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      expect(typeof numericNumber.number).toBe('number');
      expect(typeof stringNumber.number).toBe('string');
      expect(numericNumber.number).toBe(42);
      expect(stringNumber.number).toBe('PROJ-456');
    });
  });

  describe('ParsedIssueIdentifier', () => {
    test('works with GitHub URL format', () => {
      const githubParsed: ParsedIssueIdentifier = {
        identifier: '42',
        owner: 'facebook',
        repo: 'react',
        url: 'https://github.com/facebook/react/issues/42',
      };

      expect(githubParsed.identifier).toBe('42');
      expect(githubParsed.owner).toBe('facebook');
      expect(githubParsed.repo).toBe('react');
    });

    test('works with Linear URL format', () => {
      const linearParsed: ParsedIssueIdentifier = {
        identifier: 'TEAM-123',
        owner: 'company',
        repo: 'team', // This could be team key in Linear context
        url: 'https://linear.app/company/issue/TEAM-123',
      };

      expect(linearParsed.identifier).toBe('TEAM-123');
      expect(linearParsed.owner).toBe('company');
    });

    test('works with simple identifier format', () => {
      const simpleParsed: ParsedIssueIdentifier = {
        identifier: '123',
      };

      expect(simpleParsed.identifier).toBe('123');
      expect(simpleParsed.owner).toBeUndefined();
      expect(simpleParsed.repo).toBeUndefined();
    });
  });

  describe('IssueTrackerConfig', () => {
    test('works with GitHub configuration', () => {
      const githubConfig: IssueTrackerConfig = {
        type: 'github',
        apiKey: 'github_token_here',
        baseUrl: 'https://api.github.com',
        options: {
          userAgent: 'rmplan/1.0.0',
        },
      };

      expect(githubConfig.type).toBe('github');
      expect(githubConfig.apiKey).toBe('github_token_here');
      expect(githubConfig.baseUrl).toBe('https://api.github.com');
    });

    test('works with Linear configuration', () => {
      const linearConfig: IssueTrackerConfig = {
        type: 'linear',
        apiKey: 'linear_api_key_here',
        baseUrl: 'https://api.linear.app/graphql',
        options: {
          timeout: 30000,
        },
      };

      expect(linearConfig.type).toBe('linear');
      expect(linearConfig.apiKey).toBe('linear_api_key_here');
    });
  });

  describe('Optional fields', () => {
    test('IssueData works with minimal required fields', () => {
      const minimalIssue: IssueData = {
        id: '1',
        number: 1,
        title: 'Minimal Issue',
        htmlUrl: 'https://example.com/issues/1',
        state: 'open',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      expect(minimalIssue.body).toBeUndefined();
      expect(minimalIssue.user).toBeUndefined();
      expect(minimalIssue.assignees).toBeUndefined();
      expect(minimalIssue.labels).toBeUndefined();
    });

    test('CommentData works with minimal required fields', () => {
      const minimalComment: CommentData = {
        id: '1',
        body: 'Simple comment',
        createdAt: '2024-01-01T00:00:00Z',
      };

      expect(minimalComment.user).toBeUndefined();
      expect(minimalComment.updatedAt).toBeUndefined();
      expect(minimalComment.htmlUrl).toBeUndefined();
    });

    test('UserData works with different field combinations', () => {
      const githubUser: UserData = {
        id: '1',
        login: 'octocat',
        name: 'The Octocat',
        avatarUrl: 'https://github.com/images/error/octocat.gif',
      };

      const linearUser: UserData = {
        id: '2',
        name: 'Jane Developer',
        email: 'jane@company.com',
      };

      expect(githubUser.login).toBe('octocat');
      expect(githubUser.email).toBeUndefined();
      expect(linearUser.login).toBeUndefined();
      expect(linearUser.email).toBe('jane@company.com');
    });
  });

  describe('Edge cases and boundary conditions', () => {
    test('handles empty arrays and null values correctly', () => {
      const issueWithEmptyCollections: IssueData = {
        id: '1',
        number: 1,
        title: 'Test Issue',
        htmlUrl: 'https://example.com/issues/1',
        state: 'open',
        assignees: [],
        labels: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      expect(issueWithEmptyCollections.assignees).toEqual([]);
      expect(issueWithEmptyCollections.labels).toEqual([]);
      expect(issueWithEmptyCollections.body).toBeUndefined();
      expect(issueWithEmptyCollections.user).toBeUndefined();
    });

    test('handles empty strings and whitespace', () => {
      const issueWithEmptyStrings: IssueData = {
        id: '1',
        number: 1,
        title: '', // Empty title should be allowed
        body: '   ', // Whitespace-only body
        htmlUrl: 'https://example.com/issues/1',
        state: '',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      expect(issueWithEmptyStrings.title).toBe('');
      expect(issueWithEmptyStrings.body).toBe('   ');
      expect(issueWithEmptyStrings.state).toBe('');
    });

    test('handles extreme number values', () => {
      const extremeNumbers: IssueData[] = [
        {
          id: '1',
          number: 0, // Zero issue number
          title: 'Test',
          htmlUrl: 'https://example.com/issues/0',
          state: 'open',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: '2',
          number: Number.MAX_SAFE_INTEGER, // Very large number
          title: 'Test',
          htmlUrl: 'https://example.com/issues/9007199254740991',
          state: 'open',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: '3',
          number: 'VERY-LONG-LINEAR-KEY-WITH-LOTS-OF-CHARACTERS-123456', // Long Linear key
          title: 'Test',
          htmlUrl:
            'https://linear.app/company/issue/VERY-LONG-LINEAR-KEY-WITH-LOTS-OF-CHARACTERS-123456',
          state: 'open',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ];

      expect(extremeNumbers[0].number).toBe(0);
      expect(extremeNumbers[1].number).toBe(Number.MAX_SAFE_INTEGER);
      expect(extremeNumbers[2].number).toBe('VERY-LONG-LINEAR-KEY-WITH-LOTS-OF-CHARACTERS-123456');
    });

    test('handles malformed but valid data', () => {
      const malformedComment: CommentData = {
        id: '   comment_id_with_spaces   ',
        body: 'Comment with\n\nmultiple\n\n\nline breaks\n\n',
        createdAt: '2024-01-01T00:00:00.000Z', // With milliseconds
        user: {
          id: '',
          name: 'User With "Quotes" and <HTML> tags',
          login: 'user@domain.com', // Email as login (unusual but valid)
        },
      };

      expect(malformedComment.id).toBe('   comment_id_with_spaces   ');
      expect(malformedComment.body).toContain('\n\n');
      expect(malformedComment.user?.name).toContain('"Quotes"');
      expect(malformedComment.user?.login).toBe('user@domain.com');
    });
  });
});

describe('Type compatibility with existing GitHub code', () => {
  test('IssueWithComments can be used as FetchedIssueAndComments replacement', () => {
    // This test ensures our new generic types can replace the existing GitHub-specific types
    const mockFetchResult: IssueWithComments = {
      issue: {
        id: '123',
        number: 42,
        title: 'Test Issue',
        body: 'Test body',
        htmlUrl: 'https://github.com/owner/repo/issues/42',
        state: 'open',
        user: {
          id: '456',
          login: 'testuser',
          name: 'Test User',
        },
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      comments: [
        {
          id: '789',
          body: 'Test comment',
          user: {
            id: '101',
            login: 'commenter',
            name: 'Comment Author',
          },
          createdAt: '2024-01-02T00:00:00Z',
        },
      ],
    };

    // The existing code accesses these properties
    expect(mockFetchResult.issue.title).toBe('Test Issue');
    expect(mockFetchResult.issue.body).toBe('Test body');
    expect(mockFetchResult.issue.html_url).toBeUndefined(); // Old property
    expect(mockFetchResult.issue.htmlUrl).toBe('https://github.com/owner/repo/issues/42'); // New property
    expect(mockFetchResult.comments[0].body).toBe('Test comment');
    expect(mockFetchResult.comments[0].user?.login).toBe('commenter');
  });

  test('works with realistic GitHub API response structure', () => {
    // Based on actual GitHub API response structure
    // This ensures our types can handle the actual shape of GitHub responses
    const githubApiLikeIssue: IssueData = {
      id: '1234567890',
      number: 123,
      title: 'Bug: Application crashes on startup',
      body: '## Description\n\nThe application crashes immediately when starting on macOS...',
      htmlUrl: 'https://github.com/owner/repo/issues/123',
      state: 'open',
      user: {
        id: '9876543210',
        login: 'user123',
        name: 'John Doe',
        avatarUrl: 'https://avatars.githubusercontent.com/u/9876543210?v=4',
      },
      assignees: [
        {
          id: '1111111111',
          login: 'maintainer1',
          name: 'Jane Smith',
          avatarUrl: 'https://avatars.githubusercontent.com/u/1111111111?v=4',
        },
        {
          id: '2222222222',
          login: 'maintainer2',
          name: 'Bob Johnson',
          avatarUrl: 'https://avatars.githubusercontent.com/u/2222222222?v=4',
        },
      ],
      labels: [
        {
          id: '3333333333',
          name: 'bug',
          color: 'd73a4a',
        },
        {
          id: '4444444444',
          name: 'priority:high',
          color: 'b60205',
        },
        {
          id: '5555555555',
          name: 'platform:macos',
          color: '0052cc',
        },
      ],
      createdAt: '2024-01-15T10:30:45Z',
      updatedAt: '2024-01-20T14:22:33Z',
      pullRequest: false,
    };

    const githubApiLikeComment: CommentData = {
      id: '98765432',
      body: 'I can reproduce this on my machine as well. Here are the logs:\n\n```\nCrash log here...\n```',
      user: {
        id: '6666666666',
        login: 'contributor',
        name: 'Alice Brown',
        avatarUrl: 'https://avatars.githubusercontent.com/u/6666666666?v=4',
      },
      createdAt: '2024-01-16T09:15:22Z',
      updatedAt: '2024-01-16T09:20:45Z',
      htmlUrl: 'https://github.com/owner/repo/issues/123#issuecomment-98765432',
    };

    const combinedGithubData: IssueWithComments = {
      issue: githubApiLikeIssue,
      comments: [githubApiLikeComment],
    };

    // Verify the structure works exactly as expected by existing code
    expect(combinedGithubData.issue.number).toBe(123);
    expect(combinedGithubData.issue.title).toContain('Bug:');
    expect(combinedGithubData.issue.assignees).toHaveLength(2);
    expect(combinedGithubData.issue.labels).toHaveLength(3);
    expect(combinedGithubData.issue.user?.login).toBe('user123');
    expect(combinedGithubData.comments[0].body).toContain('reproduce');
    expect(combinedGithubData.comments[0].htmlUrl).toContain('#issuecomment-');
  });

  test('works with realistic Linear API response structure', () => {
    // Based on potential Linear API response structure
    const linearApiLikeIssue: IssueData = {
      id: 'linear_issue_uuid_123abc',
      number: 'TEAM-456',
      title: 'Implement dark mode for settings page',
      body: 'We need to add a dark mode toggle to the settings page to improve user experience in low-light environments.',
      htmlUrl: 'https://linear.app/company/issue/TEAM-456/implement-dark-mode-for-settings-page',
      state: 'In Progress',
      user: {
        id: 'linear_user_uuid_789def',
        name: 'Product Manager',
        email: 'pm@company.com',
        avatarUrl: 'https://avatars.linear.app/linear_user_uuid_789def',
      },
      assignees: [
        {
          id: 'linear_user_uuid_frontend',
          name: 'Frontend Developer',
          email: 'frontend@company.com',
          avatarUrl: 'https://avatars.linear.app/linear_user_uuid_frontend',
        },
      ],
      labels: [
        {
          id: 'linear_label_uuid_feature',
          name: 'Feature',
          color: '#3b82f6',
        },
        {
          id: 'linear_label_uuid_ui',
          name: 'UI/UX',
          color: '#f59e0b',
        },
      ],
      createdAt: '2024-01-20T08:00:00.000Z',
      updatedAt: '2024-01-25T16:45:30.123Z',
      pullRequest: false,
    };

    const linearApiLikeComment: CommentData = {
      id: 'linear_comment_uuid_987xyz',
      body: 'I suggest we follow the system preference by default, but also provide manual override options.',
      user: {
        id: 'linear_user_uuid_designer',
        name: 'UX Designer',
        email: 'ux@company.com',
      },
      createdAt: '2024-01-22T14:30:15.456Z',
      updatedAt: '2024-01-22T14:35:22.789Z',
    };

    const combinedLinearData: IssueWithComments = {
      issue: linearApiLikeIssue,
      comments: [linearApiLikeComment],
    };

    // Verify the structure works for Linear-style data
    expect(combinedLinearData.issue.number).toBe('TEAM-456');
    expect(combinedLinearData.issue.title).toContain('dark mode');
    expect(combinedLinearData.issue.htmlUrl).toContain('linear.app');
    expect(combinedLinearData.issue.state).toBe('In Progress');
    expect(combinedLinearData.issue.user?.email).toBe('pm@company.com');
    expect(combinedLinearData.issue.assignees?.[0].email).toBe('frontend@company.com');
    expect(combinedLinearData.comments[0].user?.name).toBe('UX Designer');
    expect(combinedLinearData.comments[0].htmlUrl).toBeUndefined(); // Linear might not provide comment URLs
  });
});

describe('IssueTrackerClient interface validation', () => {
  test('interface contract is correctly defined', () => {
    // Create a mock implementation to test the interface contract
    const mockClient: IssueTrackerClient = {
      async fetchIssue(identifier: string): Promise<IssueWithComments> {
        return {
          issue: {
            id: '1',
            number: identifier === '123' ? 123 : 'TEAM-123',
            title: 'Test Issue',
            htmlUrl: 'https://example.com/issue',
            state: 'open',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
          comments: [],
        };
      },

      async fetchAllOpenIssues(): Promise<IssueData[]> {
        return [
          {
            id: '1',
            number: 1,
            title: 'First Issue',
            htmlUrl: 'https://example.com/issue/1',
            state: 'open',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
          {
            id: '2',
            number: 2,
            title: 'Second Issue',
            htmlUrl: 'https://example.com/issue/2',
            state: 'open',
            createdAt: '2024-01-02T00:00:00Z',
            updatedAt: '2024-01-02T00:00:00Z',
          },
        ];
      },

      parseIssueIdentifier(spec: string): ParsedIssueIdentifier | null {
        if (spec === 'invalid') return null;

        const numericMatch = spec.match(/^\d+$/);
        if (numericMatch) {
          return { identifier: spec };
        }

        const urlMatch = spec.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)$/);
        if (urlMatch) {
          return {
            identifier: urlMatch[3],
            owner: urlMatch[1],
            repo: urlMatch[2],
            url: spec,
          };
        }

        return { identifier: spec };
      },

      getDisplayName(): string {
        return 'Test Issue Tracker';
      },

      getConfig(): IssueTrackerConfig {
        return {
          type: 'github',
          apiKey: 'test-key',
          baseUrl: 'https://api.example.com',
          options: { timeout: 30000 },
        };
      },
    };

    // Test that the implementation works as expected
    expect(typeof mockClient.fetchIssue).toBe('function');
    expect(typeof mockClient.fetchAllOpenIssues).toBe('function');
    expect(typeof mockClient.parseIssueIdentifier).toBe('function');
    expect(typeof mockClient.getDisplayName).toBe('function');
    expect(typeof mockClient.getConfig).toBe('function');
  });

  test('fetchIssue method returns correct structure', async () => {
    const mockClient: IssueTrackerClient = {
      async fetchIssue(): Promise<IssueWithComments> {
        return {
          issue: {
            id: 'test-id',
            number: 42,
            title: 'Test Issue',
            htmlUrl: 'https://example.com/issue/42',
            state: 'open',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
          comments: [
            {
              id: 'comment-1',
              body: 'Test comment',
              createdAt: '2024-01-02T00:00:00Z',
            },
          ],
        };
      },
      async fetchAllOpenIssues(): Promise<IssueData[]> {
        return [];
      },
      parseIssueIdentifier(): ParsedIssueIdentifier | null {
        return null;
      },
      getDisplayName(): string {
        return 'Test';
      },
      getConfig(): IssueTrackerConfig {
        return { type: 'github' };
      },
    };

    const result = await mockClient.fetchIssue('42');

    expect(result.issue.number).toBe(42);
    expect(result.issue.title).toBe('Test Issue');
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].body).toBe('Test comment');
  });

  test('parseIssueIdentifier handles various input formats', () => {
    const mockClient: IssueTrackerClient = {
      parseIssueIdentifier(spec: string): ParsedIssueIdentifier | null {
        // GitHub URL
        const githubMatch = spec.match(
          /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)$/
        );
        if (githubMatch) {
          return {
            identifier: githubMatch[3],
            owner: githubMatch[1],
            repo: githubMatch[2],
            url: spec,
          };
        }

        // Linear URL
        const linearMatch = spec.match(/^https:\/\/linear\.app\/([^\/]+)\/issue\/([A-Z]+-\d+)/);
        if (linearMatch) {
          return {
            identifier: linearMatch[2],
            owner: linearMatch[1],
            url: spec,
          };
        }

        // Simple number or key
        if (/^\d+$/.test(spec) || /^[A-Z]+-\d+$/.test(spec)) {
          return { identifier: spec };
        }

        return null;
      },
      async fetchIssue(): Promise<IssueWithComments> {
        return { issue: {} as IssueData, comments: [] };
      },
      async fetchAllOpenIssues(): Promise<IssueData[]> {
        return [];
      },
      getDisplayName(): string {
        return 'Test';
      },
      getConfig(): IssueTrackerConfig {
        return { type: 'github' };
      },
    };

    // Test various formats
    const githubUrl = mockClient.parseIssueIdentifier('https://github.com/owner/repo/issues/123');
    expect(githubUrl?.identifier).toBe('123');
    expect(githubUrl?.owner).toBe('owner');
    expect(githubUrl?.repo).toBe('repo');

    const linearUrl = mockClient.parseIssueIdentifier('https://linear.app/company/issue/TEAM-456');
    expect(linearUrl?.identifier).toBe('TEAM-456');
    expect(linearUrl?.owner).toBe('company');

    const simpleNumber = mockClient.parseIssueIdentifier('789');
    expect(simpleNumber?.identifier).toBe('789');

    const linearKey = mockClient.parseIssueIdentifier('PROJ-101');
    expect(linearKey?.identifier).toBe('PROJ-101');

    const invalid = mockClient.parseIssueIdentifier('not-valid-format');
    expect(invalid).toBeNull();
  });

  test('client factory and registry types work correctly', () => {
    const githubClientFactory: IssueTrackerClientFactory = (
      config: IssueTrackerConfig
    ): IssueTrackerClient => {
      return {
        async fetchIssue(): Promise<IssueWithComments> {
          return { issue: {} as IssueData, comments: [] };
        },
        async fetchAllOpenIssues(): Promise<IssueData[]> {
          return [];
        },
        parseIssueIdentifier(): ParsedIssueIdentifier | null {
          return null;
        },
        getDisplayName(): string {
          return 'GitHub';
        },
        getConfig(): IssueTrackerConfig {
          return config;
        },
      };
    };

    const linearClientFactory: IssueTrackerClientFactory = (
      config: IssueTrackerConfig
    ): IssueTrackerClient => {
      return {
        async fetchIssue(): Promise<IssueWithComments> {
          return { issue: {} as IssueData, comments: [] };
        },
        async fetchAllOpenIssues(): Promise<IssueData[]> {
          return [];
        },
        parseIssueIdentifier(): ParsedIssueIdentifier | null {
          return null;
        },
        getDisplayName(): string {
          return 'Linear';
        },
        getConfig(): IssueTrackerConfig {
          return config;
        },
      };
    };

    const registry: IssueTrackerRegistry = {
      github: githubClientFactory,
      linear: linearClientFactory,
    };

    // Test that factories work
    const githubClient = registry.github({ type: 'github', apiKey: 'github-key' });
    const linearClient = registry.linear({ type: 'linear', apiKey: 'linear-key' });

    expect(githubClient.getDisplayName()).toBe('GitHub');
    expect(linearClient.getDisplayName()).toBe('Linear');
    expect(githubClient.getConfig().type).toBe('github');
    expect(linearClient.getConfig().type).toBe('linear');
  });
});

describe('Date format validation', () => {
  test('handles various ISO 8601 date formats', () => {
    const dateFormats: Array<{ date: string; description: string }> = [
      { date: '2024-01-01T00:00:00Z', description: 'UTC with Z suffix' },
      { date: '2024-01-01T00:00:00.000Z', description: 'UTC with milliseconds and Z' },
      { date: '2024-01-01T00:00:00+00:00', description: 'UTC with explicit offset' },
      { date: '2024-01-01T08:00:00+08:00', description: 'With timezone offset' },
      { date: '2024-12-31T23:59:59.999Z', description: 'End of year with milliseconds' },
      { date: '2024-02-29T12:00:00Z', description: 'Leap year date' },
    ];

    dateFormats.forEach(({ date, description }) => {
      const issue: IssueData = {
        id: '1',
        number: 1,
        title: 'Test Issue',
        htmlUrl: 'https://example.com/issues/1',
        state: 'open',
        createdAt: date,
        updatedAt: date,
      };

      const comment: CommentData = {
        id: '1',
        body: 'Test comment',
        createdAt: date,
        updatedAt: date,
      };

      // Verify the dates are accepted as valid strings
      expect(issue.createdAt).toBe(date);
      expect(issue.updatedAt).toBe(date);
      expect(comment.createdAt).toBe(date);
      expect(comment.updatedAt).toBe(date);

      // Verify the dates can be parsed as valid Date objects
      expect(() => new Date(issue.createdAt)).not.toThrow();
      expect(() => new Date(comment.createdAt)).not.toThrow();
      expect(new Date(issue.createdAt).getTime()).not.toBeNaN();
      expect(new Date(comment.createdAt).getTime()).not.toBeNaN();
    });
  });

  test('handles edge date cases', () => {
    const edgeCases = [
      '2024-01-01T00:00:00.000000Z', // Microseconds (should still parse)
      '2024-01-01T00:00:00.123456Z', // More precise milliseconds
      '2024-01-01T00:00:00-05:00', // Negative timezone offset
      '2024-01-01T00:00:00+14:00', // Maximum timezone offset
    ];

    edgeCases.forEach((dateStr) => {
      const issue: IssueData = {
        id: '1',
        number: 1,
        title: 'Test Issue',
        htmlUrl: 'https://example.com/issues/1',
        state: 'open',
        createdAt: dateStr,
        updatedAt: dateStr,
      };

      // Should accept the date string format
      expect(issue.createdAt).toBe(dateStr);

      // Should be parseable as a Date (even if not standard ISO format)
      const parsedDate = new Date(dateStr);
      expect(parsedDate.getTime()).not.toBeNaN();
    });
  });

  test('date chronology validation', () => {
    // Created date should typically be before or equal to updated date
    const issueWithLogicalDates: IssueData = {
      id: '1',
      number: 1,
      title: 'Test Issue',
      htmlUrl: 'https://example.com/issues/1',
      state: 'open',
      createdAt: '2024-01-01T10:00:00Z',
      updatedAt: '2024-01-02T15:00:00Z', // Later than created
    };

    const commentWithLogicalDates: CommentData = {
      id: '1',
      body: 'Test comment',
      createdAt: '2024-01-03T08:00:00Z',
      updatedAt: '2024-01-03T09:00:00Z', // Later than created
    };

    const createdDate = new Date(issueWithLogicalDates.createdAt);
    const updatedDate = new Date(issueWithLogicalDates.updatedAt);
    const commentCreated = new Date(commentWithLogicalDates.createdAt);
    const commentUpdated = new Date(commentWithLogicalDates.updatedAt!);

    expect(createdDate.getTime()).toBeLessThanOrEqual(updatedDate.getTime());
    expect(commentCreated.getTime()).toBeLessThanOrEqual(commentUpdated.getTime());

    // Comment should typically be created after the issue
    expect(commentCreated.getTime()).toBeGreaterThanOrEqual(createdDate.getTime());
  });
});

describe('URL format validation', () => {
  test('validates GitHub URL formats', () => {
    const githubUrls = [
      'https://github.com/owner/repo/issues/123',
      'https://github.com/facebook/react/issues/1',
      'https://github.com/microsoft/vscode/issues/999999',
      'https://github.com/a/b/issues/1', // Minimal valid names
      'https://github.com/very-long-organization-name/very-long-repo-name/issues/123',
    ];

    githubUrls.forEach((url) => {
      const issue: IssueData = {
        id: '1',
        number: 1,
        title: 'Test Issue',
        htmlUrl: url,
        state: 'open',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const comment: CommentData = {
        id: '1',
        body: 'Test comment',
        createdAt: '2024-01-01T00:00:00Z',
        htmlUrl: `${url}#issuecomment-123456`,
      };

      expect(issue.htmlUrl).toBe(url);
      expect(comment.htmlUrl).toContain(url);

      // Should be valid URLs
      expect(() => new URL(issue.htmlUrl)).not.toThrow();
      expect(() => new URL(comment.htmlUrl!)).not.toThrow();
    });
  });

  test('validates Linear URL formats', () => {
    const linearUrls = [
      'https://linear.app/company/issue/TEAM-123',
      'https://linear.app/my-startup/issue/PROJ-456',
      'https://linear.app/linear/issue/LIN-789/some-issue-title-slug',
      'https://linear.app/a/issue/T-1', // Minimal format
      'https://linear.app/very-long-workspace-name/issue/VERY-LONG-TEAM-PREFIX-12345',
    ];

    linearUrls.forEach((url) => {
      const issue: IssueData = {
        id: '1',
        number: 'TEAM-123',
        title: 'Test Issue',
        htmlUrl: url,
        state: 'In Progress',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      expect(issue.htmlUrl).toBe(url);

      // Should be valid URLs
      expect(() => new URL(issue.htmlUrl)).not.toThrow();
    });
  });

  test('handles avatar URL formats', () => {
    const avatarUrls = [
      'https://avatars.githubusercontent.com/u/123456789?v=4',
      'https://avatars.githubusercontent.com/u/123456789?s=96&v=4',
      'https://avatars.linear.app/user-uuid-123',
      'https://avatars.linear.app/user-uuid-456?size=64',
      'https://gravatar.com/avatar/hash123?s=80&d=identicon',
      'https://example.com/avatars/user123.jpg',
    ];

    avatarUrls.forEach((avatarUrl) => {
      const user: UserData = {
        id: '1',
        name: 'Test User',
        avatarUrl,
      };

      expect(user.avatarUrl).toBe(avatarUrl);

      // Should be valid URLs
      expect(() => new URL(user.avatarUrl!)).not.toThrow();
    });
  });

  test('validates base API URL configurations', () => {
    const baseUrls = [
      'https://api.github.com',
      'https://api.linear.app/graphql',
      'https://github.enterprise.com/api/v3',
      'https://custom-linear.company.com/api',
    ];

    baseUrls.forEach((baseUrl) => {
      const config: IssueTrackerConfig = {
        type: 'github',
        baseUrl,
      };

      expect(config.baseUrl).toBe(baseUrl);

      // Should be valid URLs
      expect(() => new URL(config.baseUrl!)).not.toThrow();
    });
  });

  test('handles URL edge cases', () => {
    // Test URLs with special characters, ports, paths
    const edgeUrls = [
      'https://github.com/owner/repo-with-dashes/issues/123',
      'https://github.com/owner/repo_with_underscores/issues/456',
      'https://github.com/owner/repo.with.dots/issues/789',
      'https://github.enterprise.com:8080/owner/repo/issues/1',
      'https://linear.app/company-name/issue/TEAM-123?utm_source=web',
      'https://linear.app/company/issue/TEAM-456#comment-abc123',
    ];

    edgeUrls.forEach((url) => {
      const issue: IssueData = {
        id: '1',
        number: 1,
        title: 'Test Issue',
        htmlUrl: url,
        state: 'open',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      expect(issue.htmlUrl).toBe(url);
      expect(() => new URL(issue.htmlUrl)).not.toThrow();
    });
  });
});
