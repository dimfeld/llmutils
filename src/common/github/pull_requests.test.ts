import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Octokit } from 'octokit';
import { addReplyToReviewThread } from './pull_requests';
import * as logging from '../../logging';

// Mock the Octokit module
mock.module('octokit', () => ({
  Octokit: mock(({ auth }: { auth: string }) => ({
    graphql: mock(async (query: string, variables: any) => {
      if (variables.threadId === 'fail_thread') {
        throw new Error('API Error: Failed to add comment');
      }
      return {
        addPullRequestReviewThreadComment: {
          comment: {
            id: 'new_comment_id',
            url: 'https://github.com/owner/repo/pull/123#discussion_123',
          },
        },
      };
    }),
  })),
}));

// Mock the logging module
const mockDebugLog = mock();
const mockWarn = mock();
const mockError = mock();

mock.module('../../logging.ts', () => ({
  debugLog: mockDebugLog,
  warn: mockWarn,
  error: mockError,
  // Keep the original implementation for other functions
  ...logging,
}));

describe('addReplyToReviewThread', () => {
  const originalToken = process.env.GITHUB_TOKEN;
  const testToken = 'test-token';
  const owner = 'test-owner';
  const repo = 'test-repo';
  const threadId = 'test-thread-123';
  const body = 'This issue has been addressed';

  beforeEach(() => {
    process.env.GITHUB_TOKEN = testToken;
    mockDebugLog.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
    // @ts-ignore - Clear mock calls
    Octokit.mock.clear();
  });

  afterEach(() => {
    process.env.GITHUB_TOKEN = originalToken;
  });

  test('successfully adds a reply to a review thread', async () => {
    const result = await addReplyToReviewThread(owner, repo, threadId, body);

    expect(result).toBe(true);

    // Verify Octokit was called with the token
    expect(Octokit).toHaveBeenCalledTimes(1);
    expect(Octokit).toHaveBeenCalledWith({ auth: testToken });

    // Get the mock instance
    const mockInstance = Octokit.mock.results[0].value;

    // Verify graphql was called with the correct mutation and variables
    expect(mockInstance.graphql).toHaveBeenCalledTimes(1);
    const [query, variables] = mockInstance.graphql.mock.calls[0];

    expect(query).toContain('mutation AddReplyToThread');
    expect(variables).toEqual({
      threadId,
      body,
      headers: {
        'GraphQL-Features': 'timeline_edit_dialog',
      },
    });

    // Verify debug log was called
    expect(mockDebugLog).toHaveBeenCalledTimes(1);
    expect(mockDebugLog).toHaveBeenCalledWith(`Successfully added reply to thread ${threadId}`);

    // Verify no errors or warnings were logged
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  test('handles API errors gracefully', async () => {
    const failingThreadId = 'fail_thread';
    const result = await addReplyToReviewThread(owner, repo, failingThreadId, body);

    expect(result).toBe(false);

    // Verify warn was called with the error message
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      `Failed to add reply to thread ${failingThreadId}: API Error: Failed to add comment`
    );

    // Verify no debug log was called for success
    expect(mockDebugLog).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  test('returns false when GITHUB_TOKEN is not set', async () => {
    // Temporarily unset the token
    delete process.env.GITHUB_TOKEN;

    const result = await addReplyToReviewThread(owner, repo, threadId, body);

    expect(result).toBe(false);

    // Verify error was called
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockError).toHaveBeenCalledWith(
      'GITHUB_TOKEN is not set. Cannot post reply to review thread.'
    );

    // Verify no API calls were made
    expect(Octokit).not.toHaveBeenCalled();

    // Verify no other logs were called
    expect(mockDebugLog).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
