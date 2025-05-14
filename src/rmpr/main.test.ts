import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { handleRmprCommand } from './main.js';
import type { RmplanConfig } from '../rmplan/configSchema.js';
import type { DetailedReviewComment } from './types.js';
import { parsePrOrIssueNumber } from '../common/github/identifiers.js';
import { fetchPullRequestAndComments, selectReviewComments } from '../common/github/pull_requests.js';
import { fullRmfilterRun } from '../rmfilter/rmfilter.js';
import { debugLog } from '../logging.js';

describe('handleRmprCommand', () => {
  beforeEach(() => {
    // Reset mocks
    mock.module('../common/github/identifiers.js', () => ({
      parsePrOrIssueNumber: mock(() => ({
        owner: 'testowner',
        repo: 'testrepo',
        number: 123,
      })),
    }));

    mock.module('../common/github/pull_requests.js', () => ({
      fetchPullRequestAndComments: mock(() => Promise.resolve({
        pullRequest: {
          number: 123,
          title: 'Test PR',
          baseRefName: 'main',
          headRefName: 'feature',
          files: { nodes: [{ path: 'src/file1.ts' }, { path: 'src/file2.ts' }] },
          reviewThreads: { nodes: [] },
        },
      })),
      selectReviewComments: mock(() => Promise.resolve([])),
    }));

    mock.module('../rmfilter/rmfilter.js', () => ({
      fullRmfilterRun: mock(() => Promise.resolve('mock rmfilter output')),
    }));

    mock.module('../logging.js', () => ({
      debugLog: mock(),
      log: mock(),
      error: mock(),
    }));
  });

  test('applies --rmpr options to rmfilter arguments', async () => {
    const mockComments: DetailedReviewComment[] = [
      {
        comment: {
          id: 'c1',
          body: 'Fix this\n--rmpr include-all,with-importers,include pr:*.ts,rmfilter --grep example',
          diffHunk: 'mock diff',
          author: { login: 'testuser' },
        },
        thread: {
          id: 'thread-c1',
          path: 'src/file1.ts',
          originalLine: 10,
          originalStartLine: null,
          line: 10,
          startLine: null,
          diffSide: 'RIGHT',
        },
        diffForContext: [],
      },
    ];

    mock.module('../common/github/pull_requests.js', () => ({
      fetchPullRequestAndComments: mock(() => Promise.resolve({
        pullRequest: {
          number: 123,
          title: 'Test PR',
          baseRefName: 'main',
          headRefName: 'feature',
          files: { nodes: [{ path: 'src/file1.ts' }, { path: 'src/file2.ts' }] },
          reviewThreads: { nodes: mockComments.map(c => ({
            id: c.thread.id,
            path: c.thread.path,
            originalLine: c.thread.originalLine,
            originalStartLine: c.thread.originalStartLine,
            line: c.thread.line,
            startLine: c.thread.startLine,
            diffSide: c.thread.diffSide,
            comments: { nodes: [c.comment] },
          })) },
        },
      })),
      selectReviewComments: mock(() => Promise.resolve(mockComments)),
    }));

    const config: RmplanConfig = { postApplyCommands: [] };
    await handleRmprCommand(
      'testowner/testrepo#123',
      { mode: 'separate-context', yes: true, dryRun: true, run: false },
      { debug: true },
      config
    );

    const rmfilterRunCalls = (fullRmfilterRun as any).mock.calls;
    expect(rmfilterRunCalls.length).toBe(1);
    const rmfilterArgs = rmfilterRunCalls[0][0].args;
    expect(rmfilterArgs).toContain('src/file1.ts');
    expect(rmfilterArgs).toContain('src/file2.ts'); // From include-all
    expect(rmfilterArgs).toContain('--with-importers');
    expect(rmfilterArgs).toContain('*.ts'); // From include pr:*.ts
    expect(rmfilterArgs).toContain('--grep');
    expect(rmfilterArgs).toContain('example');
  });

  test('respects --rmpr no-imports option', async () => {
    const mockComments: DetailedReviewComment[] = [
      {
        comment: {
          id: 'c1',
          body: 'Fix this\n--rmpr no-imports',
          diffHunk: 'mock diff',
          author: { login: 'testuser' },
        },
        thread: {
          id: 'thread-c1',
          path: 'src/file1.ts',
          originalLine: 10,
          originalStartLine: null,
          line: 10,
          startLine: null,
          diffSide: 'RIGHT',
        },
        diffForContext: [],
      },
    ];

    mock.module('../common/github/pull_requests.js', () => ({
      fetchPullRequestAndComments: mock(() => Promise.resolve({
        pullRequest: {
          number: 123,
          title: 'Test PR',
          baseRefName: 'main',
          headRefName: 'feature',
          files: { nodes: [{ path: 'src/file1.ts' }] },
          reviewThreads: { nodes: mockComments.map(c => ({
            id: c.thread.id,
            path: c.thread.path,
            originalLine: c.thread.originalLine,
            originalStartLine: c.thread.originalStartLine,
            line: c.thread.line,
            startLine: c.thread.startLine,
            diffSide: c.thread.diffSide,
            comments: { nodes: [c.comment] },
          })) },
        },
      })),
      selectReviewComments: mock(() => Promise.resolve(mockComments)),
    }));

    const config: RmplanConfig = { postApplyCommands: [] };
    await handleRmprCommand(
      'testowner/testrepo#123',
      { mode: 'separate-context', yes: true, dryRun: true, run: false },
      { debug: true },
      config
    );

    const rmfilterRunCalls = (fullRmfilterRun as any).mock.calls;
    expect(rmfilterRunCalls.length).toBe(1);
    const rmfilterArgs = rmfilterRunCalls[0][0].args;
    expect(rmfilterArgs).toContain('src/file1.ts');
    expect(rmfilterArgs).not.toContain('--with-imports');
  });
});
