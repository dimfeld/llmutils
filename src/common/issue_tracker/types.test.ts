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
});