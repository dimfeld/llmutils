import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ModuleMocker } from '../testing.ts';
import { LinearIssueTrackerClient, createLinearClient } from './linear.ts';
import type { IssueTrackerConfig } from './issue_tracker/types.ts';

describe('LinearIssueTrackerClient', () => {
  const moduleMocker = new ModuleMocker(import.meta);

  const mockConfig: IssueTrackerConfig = {
    type: 'linear',
    apiKey: 'test-linear-api-key',
  };

  beforeEach(() => {
    // Mock environment for Linear client
    process.env.LINEAR_API_KEY = 'test-linear-api-key';
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  describe('parseIssueIdentifier', () => {
    test('parses Linear issue key format', () => {
      const client = new LinearIssueTrackerClient(mockConfig);

      const result1 = client.parseIssueIdentifier('TEAM-123');
      expect(result1).toEqual({
        identifier: 'TEAM-123',
      });

      const result2 = client.parseIssueIdentifier('ABC-456');
      expect(result2).toEqual({
        identifier: 'ABC-456',
      });

      const result3 = client.parseIssueIdentifier('PROJECT123-789');
      expect(result3).toEqual({
        identifier: 'PROJECT123-789',
      });
    });

    test('parses Linear URL format', () => {
      const client = new LinearIssueTrackerClient(mockConfig);

      const result1 = client.parseIssueIdentifier('https://linear.app/company/issue/TEAM-123');
      expect(result1).toEqual({
        identifier: 'TEAM-123',
        owner: 'company',
        url: 'https://linear.app/company/issue/TEAM-123',
      });

      const result2 = client.parseIssueIdentifier(
        'https://linear.app/workspace/issue/PROJ-456/some-title-slug'
      );
      expect(result2).toEqual({
        identifier: 'PROJ-456',
        owner: 'workspace',
        url: 'https://linear.app/workspace/issue/PROJ-456/some-title-slug',
      });
    });

    test('handles whitespace in input', () => {
      const client = new LinearIssueTrackerClient(mockConfig);

      const result = client.parseIssueIdentifier('  TEAM-123  ');
      expect(result).toEqual({
        identifier: 'TEAM-123',
      });
    });

    test('returns null for invalid formats', () => {
      const client = new LinearIssueTrackerClient(mockConfig);

      expect(client.parseIssueIdentifier('123')).toBeNull(); // Just a number
      expect(client.parseIssueIdentifier('TEAM123')).toBeNull(); // Missing dash
      expect(client.parseIssueIdentifier('TEAM-')).toBeNull(); // Missing number
      expect(client.parseIssueIdentifier('https://github.com/owner/repo/issues/123')).toBeNull(); // GitHub URL
      expect(client.parseIssueIdentifier('')).toBeNull(); // Empty string
      expect(client.parseIssueIdentifier('invalid-format')).toBeNull(); // Invalid format
    });
  });

  describe('fetchIssue', () => {
    test('throws error when LINEAR_API_KEY is missing', async () => {
      // Clear the environment variable
      delete process.env.LINEAR_API_KEY;

      await moduleMocker.mock('./linear_client.ts', () => ({
        getLinearClient: mock(() => {
          throw new Error(
            'LINEAR_API_KEY environment variable is not set. ' +
              'Please set your Linear API key to use Linear integration. ' +
              'You can obtain an API key from: https://linear.app/settings/api'
          );
        }),
      }));

      const client = new LinearIssueTrackerClient(mockConfig);

      await expect(client.fetchIssue('TEAM-123')).rejects.toThrow(
        'LINEAR_API_KEY environment variable is not set'
      );

      // Restore the environment variable for other tests
      process.env.LINEAR_API_KEY = 'test-linear-api-key';
    });

    test('fetches issue with comments successfully', async () => {
      const mockLinearClient = {
        issue: mock(async (id: string) => ({
          id: 'issue-uuid-123',
          identifier: 'TEAM-123',
          title: 'Test Issue',
          description: 'This is a test issue description',
          url: 'https://linear.app/company/issue/TEAM-123',
          creator: {
            id: 'user-uuid-1',
            name: 'John Doe',
            email: 'john@example.com',
            avatarUrl: 'https://avatars.linear.app/user1',
          },
          assignee: {
            id: 'user-uuid-2',
            name: 'Jane Smith',
            email: 'jane@example.com',
            avatarUrl: 'https://avatars.linear.app/user2',
          },
          labels: mock(async () => ({
            nodes: [
              { id: 'label-1', name: 'Bug', color: '#ff0000' },
              { id: 'label-2', name: 'High Priority', color: '#ffa500' },
            ],
          })),
          state: Promise.resolve({ name: 'In Progress' }),
          project: Promise.resolve(null),
          createdAt: new Date('2024-01-15T10:30:00Z'),
          updatedAt: new Date('2024-01-16T14:22:00Z'),
          comments: mock(async () => ({
            nodes: [
              {
                id: 'comment-uuid-1',
                body: 'This is a comment',
                user: {
                  id: 'user-uuid-3',
                  name: 'Bob Wilson',
                  email: 'bob@example.com',
                },
                createdAt: new Date('2024-01-16T09:15:00Z'),
                updatedAt: new Date('2024-01-16T09:20:00Z'),
              },
              {
                id: 'comment-uuid-2',
                body: 'Another comment',
                user: {
                  id: 'user-uuid-4',
                  name: 'Alice Brown',
                  email: 'alice@example.com',
                },
                createdAt: new Date('2024-01-16T10:30:00Z'),
                updatedAt: undefined,
              },
            ],
          })),
        })),
      };

      await moduleMocker.mock('./linear_client.ts', () => ({
        getLinearClient: mock(() => mockLinearClient),
      }));

      const client = new LinearIssueTrackerClient(mockConfig);
      const result = await client.fetchIssue('TEAM-123');

      expect(result.issue).toEqual({
        id: 'issue-uuid-123',
        number: 'TEAM-123',
        title: 'Test Issue',
        body: 'This is a test issue description',
        htmlUrl: 'https://linear.app/company/issue/TEAM-123',
        state: 'In Progress',
        user: {
          id: 'user-uuid-1',
          name: 'John Doe',
          email: 'john@example.com',
          avatarUrl: 'https://avatars.linear.app/user1',
          login: undefined,
        },
        assignees: [
          {
            id: 'user-uuid-2',
            name: 'Jane Smith',
            email: 'jane@example.com',
            avatarUrl: 'https://avatars.linear.app/user2',
            login: undefined,
          },
        ],
        labels: [
          { id: 'label-1', name: 'Bug', color: '#ff0000' },
          { id: 'label-2', name: 'High Priority', color: '#ffa500' },
        ],
        createdAt: '2024-01-15T10:30:00.000Z',
        updatedAt: '2024-01-16T14:22:00.000Z',
        pullRequest: false,
        project: undefined,
      });

      expect(result.comments).toEqual([
        {
          id: 'comment-uuid-1',
          body: 'This is a comment',
          user: {
            id: 'user-uuid-3',
            name: 'Bob Wilson',
            email: 'bob@example.com',
            avatarUrl: undefined,
            login: undefined,
          },
          createdAt: '2024-01-16T09:15:00.000Z',
          updatedAt: '2024-01-16T09:20:00.000Z',
          htmlUrl: undefined,
        },
        {
          id: 'comment-uuid-2',
          body: 'Another comment',
          user: {
            id: 'user-uuid-4',
            name: 'Alice Brown',
            email: 'alice@example.com',
            avatarUrl: undefined,
            login: undefined,
          },
          createdAt: '2024-01-16T10:30:00.000Z',
          updatedAt: undefined,
          htmlUrl: undefined,
        },
      ]);

      expect(mockLinearClient.issue).toHaveBeenCalledWith('TEAM-123');
    });

    test('handles issue with minimal data', async () => {
      const mockLinearClient = {
        issue: mock(async (id: string) => ({
          id: 'issue-uuid-456',
          identifier: 'TEAM-456',
          title: 'Minimal Issue',
          description: undefined,
          url: 'https://linear.app/company/issue/TEAM-456',
          creator: undefined,
          assignee: undefined,
          labels: mock(async () => ({ nodes: [] })),
          state: Promise.resolve(undefined),
          project: Promise.resolve(null),
          createdAt: new Date('2024-01-01T00:00:00Z'),
          updatedAt: new Date('2024-01-01T00:00:00Z'),
          comments: mock(async () => ({ nodes: [] })),
        })),
      };

      await moduleMocker.mock('./linear_client.ts', () => ({
        getLinearClient: mock(() => mockLinearClient),
      }));

      const client = new LinearIssueTrackerClient(mockConfig);
      const result = await client.fetchIssue('TEAM-456');

      expect(result.issue).toEqual({
        id: 'issue-uuid-456',
        number: 'TEAM-456',
        title: 'Minimal Issue',
        body: undefined,
        htmlUrl: 'https://linear.app/company/issue/TEAM-456',
        state: 'Unknown',
        user: undefined,
        assignees: [],
        labels: undefined,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        pullRequest: false,
        project: undefined,
      });

      expect(result.comments).toEqual([]);
    });

    test('fetches issue with project data successfully', async () => {
      const mockLinearClient = {
        issue: mock(async (id: string) => ({
          id: 'issue-uuid-789',
          identifier: 'TEAM-789',
          title: 'Project Issue',
          description: 'This issue belongs to a project',
          url: 'https://linear.app/company/issue/TEAM-789',
          creator: {
            id: 'user-uuid-1',
            name: 'John Doe',
            email: 'john@example.com',
          },
          assignee: null,
          labels: mock(async () => ({ nodes: [] })),
          state: Promise.resolve({ name: 'Todo' }),
          project: Promise.resolve({
            name: 'My Awesome Project',
            description: 'This is a comprehensive project to improve our platform',
          }),
          createdAt: new Date('2024-01-20T10:00:00Z'),
          updatedAt: new Date('2024-01-20T10:00:00Z'),
          comments: mock(async () => ({ nodes: [] })),
        })),
      };

      await moduleMocker.mock('./linear_client.ts', () => ({
        getLinearClient: mock(() => mockLinearClient),
      }));

      const client = new LinearIssueTrackerClient(mockConfig);
      const result = await client.fetchIssue('TEAM-789');

      expect(result.issue.project).toEqual({
        name: 'My Awesome Project',
        description: 'This is a comprehensive project to improve our platform',
      });

      expect(result.issue.id).toBe('issue-uuid-789');
      expect(result.issue.title).toBe('Project Issue');
    });

    test('throws error for invalid identifier', async () => {
      const client = new LinearIssueTrackerClient(mockConfig);

      await expect(client.fetchIssue('invalid-format')).rejects.toThrow(
        'Invalid Linear issue identifier: invalid-format'
      );
    });

    test('throws error when issue not found', async () => {
      const mockLinearClient = {
        issue: mock(async (id: string) => null),
      };

      await moduleMocker.mock('./linear_client.ts', () => ({
        getLinearClient: mock(() => mockLinearClient),
      }));

      const client = new LinearIssueTrackerClient(mockConfig);

      await expect(client.fetchIssue('TEAM-404')).rejects.toThrow('Issue not found: TEAM-404');
      expect(mockLinearClient.issue).toHaveBeenCalledWith('TEAM-404');
    });

    test('handles Linear SDK errors', async () => {
      const mockLinearClient = {
        issue: mock(async (id: string) => {
          throw new Error('Linear API error');
        }),
      };

      await moduleMocker.mock('./linear_client.ts', () => ({
        getLinearClient: mock(() => mockLinearClient),
      }));

      const client = new LinearIssueTrackerClient(mockConfig);

      await expect(client.fetchIssue('TEAM-123')).rejects.toThrow(
        'Failed to fetch Linear issue TEAM-123: Linear API error'
      );
    });

    test('accepts Linear URL as identifier', async () => {
      const mockLinearClient = {
        issue: mock(async (id: string) => ({
          id: 'issue-uuid-123',
          identifier: 'TEAM-123',
          title: 'URL Test Issue',
          description: 'Fetched by URL',
          url: 'https://linear.app/company/issue/TEAM-123',
          creator: undefined,
          assignee: undefined,
          labels: mock(async () => ({ nodes: [] })),
          state: Promise.resolve({ name: 'Open' }),
          createdAt: new Date('2024-01-01T00:00:00Z'),
          updatedAt: new Date('2024-01-01T00:00:00Z'),
          comments: mock(async () => ({ nodes: [] })),
        })),
      };

      await moduleMocker.mock('./linear_client.ts', () => ({
        getLinearClient: mock(() => mockLinearClient),
      }));

      const client = new LinearIssueTrackerClient(mockConfig);
      const result = await client.fetchIssue('https://linear.app/company/issue/TEAM-123');

      expect(result.issue.title).toBe('URL Test Issue');
      expect(mockLinearClient.issue).toHaveBeenCalledWith('TEAM-123');
    });

    test('handles large text content correctly', async () => {
      const largeDescription = 'A'.repeat(10000); // 10KB description
      const largeComment = 'B'.repeat(5000); // 5KB comment

      const mockLinearClient = {
        issue: mock(async (id: string) => ({
          id: 'issue-uuid-large',
          identifier: 'TEAM-999',
          title: 'Large Content Issue',
          description: largeDescription,
          url: 'https://linear.app/company/issue/TEAM-LARGE',
          creator: {
            id: 'user-1',
            name: 'User One',
          },
          assignee: undefined,
          labels: mock(async () => ({ nodes: [] })),
          state: Promise.resolve({ name: 'Open' }),
          createdAt: new Date('2024-01-01T00:00:00Z'),
          updatedAt: new Date('2024-01-01T00:00:00Z'),
          comments: mock(async () => ({
            nodes: [
              {
                id: 'comment-large',
                body: largeComment,
                user: {
                  id: 'user-2',
                  name: 'User Two',
                },
                createdAt: new Date('2024-01-01T10:00:00Z'),
                updatedAt: new Date('2024-01-01T10:00:00Z'),
              },
            ],
          })),
        })),
      };

      await moduleMocker.mock('./linear_client.ts', () => ({
        getLinearClient: mock(() => mockLinearClient),
      }));

      const client = new LinearIssueTrackerClient(mockConfig);
      const result = await client.fetchIssue('TEAM-999');

      expect(result.issue.body).toBe(largeDescription);
      expect(result.issue.body?.length).toBe(10000);
      expect(result.comments[0].body).toBe(largeComment);
      expect(result.comments[0].body.length).toBe(5000);
    });
  });

  describe('fetchAllOpenIssues', () => {
    test('handles pagination failure gracefully', async () => {
      const mockFirstPage = {
        nodes: [
          {
            id: 'issue-1',
            identifier: 'TEAM-1',
            title: 'First Issue',
            description: 'First issue description',
            url: 'https://linear.app/company/issue/TEAM-1',
            creator: undefined,
            assignee: undefined,
            labels: mock(async () => ({ nodes: [] })),
            state: Promise.resolve({ name: 'In Progress' }),
            project: Promise.resolve(null),
            createdAt: new Date('2024-01-01T00:00:00Z'),
            updatedAt: new Date('2024-01-01T00:00:00Z'),
          },
        ],
        pageInfo: { hasNextPage: true },
        fetchNext: mock(async () => {
          throw new Error('Pagination failed');
        }),
      };

      const mockLinearClient = {
        issues: mock(async (options: any) => mockFirstPage),
      };

      await moduleMocker.mock('./linear_client.ts', () => ({
        getLinearClient: mock(() => mockLinearClient),
      }));

      const client = new LinearIssueTrackerClient(mockConfig);

      await expect(client.fetchAllOpenIssues()).rejects.toThrow(
        'Failed to fetch open Linear issues: Pagination failed'
      );
    });

    test('fetches all open issues with pagination', async () => {
      const mockFirstPage = {
        nodes: [
          {
            id: 'issue-1',
            identifier: 'TEAM-1',
            title: 'First Issue',
            description: 'First issue description',
            url: 'https://linear.app/company/issue/TEAM-1',
            creator: {
              id: 'user-1',
              name: 'Creator One',
            },
            assignee: undefined,
            labels: mock(async () => ({ nodes: [] })),
            state: Promise.resolve({ name: 'In Progress' }),
            project: Promise.resolve(null),
            createdAt: new Date('2024-01-01T00:00:00Z'),
            updatedAt: new Date('2024-01-01T00:00:00Z'),
          },
          {
            id: 'issue-2',
            identifier: 'TEAM-2',
            title: 'Second Issue',
            description: undefined,
            url: 'https://linear.app/company/issue/TEAM-2',
            creator: undefined,
            assignee: {
              id: 'user-2',
              name: 'Assignee Two',
            },
            labels: mock(async () => ({
              nodes: [{ id: 'label-1', name: 'Bug', color: '#ff0000' }],
            })),
            state: Promise.resolve({ name: 'Todo' }),
            project: Promise.resolve(null),
            createdAt: new Date('2024-01-02T00:00:00Z'),
            updatedAt: new Date('2024-01-02T00:00:00Z'),
          },
        ],
        pageInfo: { hasNextPage: true },
        fetchNext: mock(async () => mockSecondPage),
      };

      const mockSecondPage = {
        nodes: [
          {
            id: 'issue-3',
            identifier: 'TEAM-3',
            title: 'Third Issue',
            description: 'Third issue description',
            url: 'https://linear.app/company/issue/TEAM-3',
            creator: {
              id: 'user-3',
              name: 'Creator Three',
            },
            assignee: undefined,
            labels: mock(async () => ({ nodes: [] })),
            state: Promise.resolve({ name: 'Open' }),
            project: Promise.resolve(null),
            createdAt: new Date('2024-01-03T00:00:00Z'),
            updatedAt: new Date('2024-01-03T00:00:00Z'),
          },
        ],
        pageInfo: { hasNextPage: false },
        fetchNext: mock(),
      };

      const mockLinearClient = {
        issues: mock(async (options: any) => mockFirstPage),
      };

      await moduleMocker.mock('./linear_client.ts', () => ({
        getLinearClient: mock(() => mockLinearClient),
      }));

      const client = new LinearIssueTrackerClient(mockConfig);
      const result = await client.fetchAllOpenIssues();

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        id: 'issue-1',
        number: 'TEAM-1',
        title: 'First Issue',
        body: 'First issue description',
        htmlUrl: 'https://linear.app/company/issue/TEAM-1',
        state: 'In Progress',
        user: {
          id: 'user-1',
          name: 'Creator One',
          email: undefined,
          avatarUrl: undefined,
          login: undefined,
        },
        assignees: [],
        labels: undefined,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        pullRequest: false,
        project: undefined,
      });
      expect(result[1]).toEqual({
        id: 'issue-2',
        number: 'TEAM-2',
        title: 'Second Issue',
        body: undefined,
        htmlUrl: 'https://linear.app/company/issue/TEAM-2',
        state: 'Todo',
        user: undefined,
        assignees: [
          {
            id: 'user-2',
            name: 'Assignee Two',
            email: undefined,
            avatarUrl: undefined,
            login: undefined,
          },
        ],
        labels: [{ id: 'label-1', name: 'Bug', color: '#ff0000' }],
        createdAt: '2024-01-02T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
        pullRequest: false,
        project: undefined,
      });
      expect(result[2].id).toBe('issue-3');

      // Verify the correct filter was applied
      expect(mockLinearClient.issues).toHaveBeenCalledWith({
        filter: {
          state: {
            type: { nin: ['completed', 'canceled'] },
          },
        },
        orderBy: 'updatedAt',
      });

      // Verify pagination was handled
      expect(mockFirstPage.fetchNext).toHaveBeenCalledTimes(1);
    });

    test('handles no issues', async () => {
      const mockEmptyConnection = {
        nodes: [],
        pageInfo: { hasNextPage: false },
        fetchNext: mock(),
      };

      const mockLinearClient = {
        issues: mock(async (options: any) => mockEmptyConnection),
      };

      await moduleMocker.mock('./linear_client.ts', () => ({
        getLinearClient: mock(() => mockLinearClient),
      }));

      const client = new LinearIssueTrackerClient(mockConfig);
      const result = await client.fetchAllOpenIssues();

      expect(result).toEqual([]);
      expect(mockEmptyConnection.fetchNext).not.toHaveBeenCalled();
    });

    test('handles Linear SDK errors', async () => {
      const mockLinearClient = {
        issues: mock(async () => {
          throw new Error('Linear API error');
        }),
      };

      await moduleMocker.mock('./linear_client.ts', () => ({
        getLinearClient: mock(() => mockLinearClient),
      }));

      const client = new LinearIssueTrackerClient(mockConfig);

      await expect(client.fetchAllOpenIssues()).rejects.toThrow(
        'Failed to fetch open Linear issues: Linear API error'
      );
    });
  });

  describe('getDisplayName', () => {
    test('returns Linear display name', () => {
      const client = new LinearIssueTrackerClient(mockConfig);
      expect(client.getDisplayName()).toBe('Linear');
    });
  });

  describe('getConfig', () => {
    test('returns client configuration', () => {
      const client = new LinearIssueTrackerClient(mockConfig);
      expect(client.getConfig()).toEqual(mockConfig);
    });
  });

  describe('mapLinearUserToUserData', () => {
    test('maps Linear user with full data', () => {
      const client = new LinearIssueTrackerClient(mockConfig);

      const linearUser = {
        id: 'user-123',
        name: 'John Doe',
        displayName: 'Johnny',
        email: 'john@example.com',
        avatarUrl: 'https://avatars.linear.app/user123',
      };

      // Access the private method for testing
      const result = (client as any).mapLinearUserToUserData(linearUser);

      expect(result).toEqual({
        id: 'user-123',
        name: 'John Doe',
        email: 'john@example.com',
        avatarUrl: 'https://avatars.linear.app/user123',
        login: undefined,
      });
    });

    test('maps Linear user with displayName fallback', () => {
      const client = new LinearIssueTrackerClient(mockConfig);

      const linearUser = {
        id: 'user-456',
        displayName: 'Jane Smith',
        email: undefined,
      };

      const result = (client as any).mapLinearUserToUserData(linearUser);

      expect(result).toEqual({
        id: 'user-456',
        name: 'Jane Smith',
        email: undefined,
        avatarUrl: undefined,
        login: undefined,
      });
    });

    test('maps Linear user with minimal data', () => {
      const client = new LinearIssueTrackerClient(mockConfig);

      const linearUser = {
        id: 'user-789',
      };

      const result = (client as any).mapLinearUserToUserData(linearUser);

      expect(result).toEqual({
        id: 'user-789',
        name: undefined,
        email: undefined,
        avatarUrl: undefined,
        login: undefined,
      });
    });
  });
});

describe('createLinearClient', () => {
  test('creates LinearIssueTrackerClient instance', () => {
    const config: IssueTrackerConfig = {
      type: 'linear',
      apiKey: 'test-key',
    };

    const client = createLinearClient(config);

    expect(client).toBeInstanceOf(LinearIssueTrackerClient);
    expect(client.getDisplayName()).toBe('Linear');
    expect(client.getConfig()).toEqual(config);
  });
});
