import { describe, test, expect, vi, beforeEach } from 'bun:test';
import { handleRmprCommand } from './main';
import { fetchPullRequestAndComments, fetchOpenPullRequests } from '../common/github/pull_requests';
import { getCurrentBranchName } from './git_utils';
import { parsePrOrIssueNumber } from '../common/github/identifiers';
import { error, warn } from '../logging';
import { confirm } from '@inquirer/prompts';

// Mock dependencies
vi.mock('../common/github/pull_requests');
vi.mock('./git_utils');
vi.mock('../common/github/identifiers');
vi.mock('../logging');
vi.mock('@inquirer/prompts', async () => {
  const actual = await vi.importActual('@inquirer/prompts');
  return {
    ...actual,
    confirm: vi.fn(),
  };
});

describe('handleRmprCommand - Branch Mismatch Warning', () => {
  const mockPrData = {
    pullRequest: {
      number: 123,
      title: 'Test PR',
      body: 'Test PR body',
      baseRefName: 'main',
      headRefName: 'feature-branch',
      files: { nodes: [] },
      reviewThreads: { nodes: [] },
    },
  };

  const mockOptions = {
    mode: 'separate-context',
    yes: false,
    dryRun: false,
    run: false,
    commit: false,
  };

  const mockGlobalCliOptions = { debug: false };
  const mockConfig = {};

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock fetchPullRequestAndComments to return our mock PR data
    (fetchPullRequestAndComments as jest.Mock).mockResolvedValue(mockPrData);
    // Mock parsePrOrIssueNumber to return a valid PR identifier
    (parsePrOrIssueNumber as jest.Mock).mockImplementation((arg) =>
      arg ? { owner: 'test', repo: 'repo', number: 123 } : null
    );
  });

  test('should not warn when current branch matches PR head branch', async () => {
    // Arrange
    (getCurrentBranchName as jest.Mock).mockResolvedValue('feature-branch');

    // Act
    await handleRmprCommand('123', mockOptions, mockGlobalCliOptions, mockConfig);

    // Assert
    expect(warn).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  test('should warn and proceed when current branch does not match PR head branch and user confirms', async () => {
    // Arrange
    (getCurrentBranchName as jest.Mock).mockResolvedValue('different-branch');
    (confirm as jest.Mock).mockResolvedValue(true);

    // Act
    await handleRmprCommand('123', mockOptions, mockGlobalCliOptions, mockConfig);

    // Assert
    expect(warn).toHaveBeenCalledWith(
      'Current local branch "different-branch" does not match the PR\'s head branch "feature-branch".'
    );
    expect(confirm).toHaveBeenCalledWith({
      message: 'Proceed with this PR anyway?',
      default: true,
    });
    // Should not exit early
    expect(fetchPullRequestAndComments).toHaveBeenCalled();
  });

  test('should warn and exit when current branch does not match PR head branch and user denies', async () => {
    // Arrange
    (getCurrentBranchName as jest.Mock).mockResolvedValue('different-branch');
    (confirm as jest.Mock).mockResolvedValue(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit() called');
    });

    // Act & Assert
    await expect(
      handleRmprCommand('123', mockOptions, mockGlobalCliOptions, mockConfig)
    ).rejects.toThrow('process.exit() called');

    expect(warn).toHaveBeenCalledWith(
      'Current local branch "different-branch" does not match the PR\'s head branch "feature-branch".'
    );
    expect(confirm).toHaveBeenCalledWith({
      message: 'Proceed with this PR anyway?',
      default: true,
    });
    expect(exitSpy).toHaveBeenCalledWith(0);

    // Cleanup
    exitSpy.mockRestore();
  });

  test('should not prompt when yes flag is true, just log warning', async () => {
    // Arrange
    (getCurrentBranchName as jest.Mock).mockResolvedValue('different-branch');

    // Act
    await handleRmprCommand('123', { ...mockOptions, yes: true }, mockGlobalCliOptions, mockConfig);

    // Assert
    expect(warn).toHaveBeenCalledWith(
      'Current local branch "different-branch" does not match the PR\'s head branch "feature-branch".'
    );
    expect(confirm).not.toHaveBeenCalled();
    // Should continue execution
    expect(fetchPullRequestAndComments).toHaveBeenCalled();
  });

  test('should not check branch mismatch when PR was autodetected', async () => {
    // Arrange
    (fetchOpenPullRequests as jest.Mock).mockResolvedValue([
      { number: 123, title: 'Test PR', headRefName: 'feature-branch', user: { login: 'test' } },
    ]);
    (getCurrentBranchName as jest.Mock).mockResolvedValue('feature-branch');

    // Act - Call with undefined prIdentifierArg to trigger autodetection
    await handleRmprCommand(undefined, mockOptions, mockGlobalCliOptions, mockConfig);

    // Assert - Even though we set up a branch mismatch, it shouldn't check because it was autodetected
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('does not match'));
    expect(confirm).not.toHaveBeenCalled();
  });

  test('should not warn when getCurrentBranchName returns null', async () => {
    // Arrange
    (getCurrentBranchName as jest.Mock).mockResolvedValue(null);

    // Act
    await handleRmprCommand('123', mockOptions, mockGlobalCliOptions, mockConfig);

    // Assert
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('does not match'));
    expect(confirm).not.toHaveBeenCalled();
  });
});
