import { afterEach, describe, expect, mock, test } from 'bun:test';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('common/github/pr_status', () => {
  afterEach(() => {
    moduleMocker.clear();
  });

  test('fetchPrFullStatus normalizes checks, reviews, and labels', async () => {
    const graphql = mock(async () => ({
      repository: {
        pullRequest: {
          number: 42,
          title: 'Add PR status monitoring',
          state: 'OPEN',
          isDraft: false,
          mergeable: 'MERGEABLE',
          mergedAt: null,
          headRefOid: 'abc123',
          baseRefName: 'main',
          headRefName: 'feature/pr-status',
          reviewDecision: 'APPROVED',
          labels: {
            nodes: [null, { name: 'backend', color: '00ff00' }],
          },
          reviews: {
            nodes: [
              null,
              {
                author: { login: 'reviewer-1' },
                state: 'APPROVED',
                submittedAt: '2026-03-20T00:00:00.000Z',
              },
              {
                author: null,
                state: 'COMMENTED',
                submittedAt: '2026-03-20T00:01:00.000Z',
              },
            ],
          },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: 'FAILURE',
                    contexts: {
                      nodes: [
                        null,
                        {
                          __typename: 'CheckRun',
                          name: 'unit tests',
                          status: 'COMPLETED',
                          conclusion: 'SUCCESS',
                          detailsUrl: 'https://example.com/checks/1',
                          startedAt: '2026-03-20T00:00:00.000Z',
                          completedAt: '2026-03-20T00:02:00.000Z',
                        },
                        {
                          __typename: 'StatusContext',
                          context: 'buildkite',
                          state: 'PENDING',
                          targetUrl: 'https://example.com/status/2',
                          createdAt: '2026-03-20T00:03:00.000Z',
                        },
                        {
                          __typename: 'StatusContext',
                          context: 'legacy-ci',
                          state: 'ERROR',
                          targetUrl: null,
                          createdAt: '2026-03-20T00:04:00.000Z',
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    }));

    await moduleMocker.mock('octokit', () => ({
      Octokit: mock(function () {
        return {
          graphql,
        };
      }),
    }));

    const { fetchPrFullStatus } = await import('./pr_status.ts');
    const result = await fetchPrFullStatus('owner', 'repo', 42);

    expect(result).toEqual({
      number: 42,
      title: 'Add PR status monitoring',
      state: 'open',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergedAt: null,
      headSha: 'abc123',
      baseRefName: 'main',
      headRefName: 'feature/pr-status',
      reviewDecision: 'APPROVED',
      labels: [{ name: 'backend', color: '00ff00' }],
      reviews: [
        {
          author: 'reviewer-1',
          state: 'APPROVED',
          submittedAt: '2026-03-20T00:00:00.000Z',
        },
      ],
      checks: [
        {
          name: 'unit tests',
          status: 'completed',
          conclusion: 'success',
          detailsUrl: 'https://example.com/checks/1',
          startedAt: '2026-03-20T00:00:00.000Z',
          completedAt: '2026-03-20T00:02:00.000Z',
          source: 'check_run',
        },
        {
          name: 'buildkite',
          status: 'pending',
          conclusion: null,
          detailsUrl: 'https://example.com/status/2',
          startedAt: null,
          completedAt: null,
          source: 'status_context',
        },
        {
          name: 'legacy-ci',
          status: 'completed',
          conclusion: 'error',
          detailsUrl: null,
          startedAt: null,
          completedAt: '2026-03-20T00:04:00.000Z',
          source: 'status_context',
        },
      ],
      checkRollupState: 'failure',
    });
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  test('fetchPrFullStatus keeps only the latest review per author', async () => {
    const graphql = mock(async () => ({
      repository: {
        pullRequest: {
          number: 49,
          title: 'Deduplicate reviews',
          state: 'OPEN',
          isDraft: false,
          mergeable: 'MERGEABLE',
          mergedAt: null,
          headRefOid: 'def456',
          baseRefName: 'main',
          headRefName: 'feature/review-dedupe',
          reviewDecision: 'APPROVED',
          labels: {
            nodes: [],
          },
          reviews: {
            nodes: [
              {
                author: { login: 'reviewer-1' },
                state: 'CHANGES_REQUESTED',
                submittedAt: '2026-03-20T00:00:00.000Z',
              },
              {
                author: { login: 'reviewer-2' },
                state: 'COMMENTED',
                submittedAt: '2026-03-20T00:01:00.000Z',
              },
              {
                author: { login: 'reviewer-1' },
                state: 'APPROVED',
                submittedAt: '2026-03-20T00:02:00.000Z',
              },
              {
                author: { login: 'reviewer-2' },
                state: 'APPROVED',
                submittedAt: '2026-03-20T00:03:00.000Z',
              },
            ],
          },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: 'SUCCESS',
                    contexts: {
                      nodes: [],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    }));

    await moduleMocker.mock('octokit', () => ({
      Octokit: mock(function () {
        return {
          graphql,
        };
      }),
    }));

    const { fetchPrFullStatus } = await import('./pr_status.ts');

    await expect(fetchPrFullStatus('owner', 'repo', 49)).resolves.toMatchObject({
      reviews: [
        {
          author: 'reviewer-1',
          state: 'APPROVED',
          submittedAt: '2026-03-20T00:02:00.000Z',
        },
        {
          author: 'reviewer-2',
          state: 'APPROVED',
          submittedAt: '2026-03-20T00:03:00.000Z',
        },
      ],
    });
  });

  test('throws for unknown check statuses and conclusions', async () => {
    const graphql = mock(async (_query: string, variables: { prNumber: number }) => {
      if (variables.prNumber === 46) {
        return {
          repository: {
            pullRequest: {
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        state: 'PENDING',
                        contexts: {
                          nodes: [
                            {
                              __typename: 'CheckRun',
                              name: 'mystery-check',
                              status: 'BLOCKED',
                              conclusion: null,
                              detailsUrl: null,
                              startedAt: null,
                              completedAt: null,
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        };
      }

      return {
        repository: {
          pullRequest: {
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      state: 'FAILURE',
                      contexts: {
                        nodes: [
                          {
                            __typename: 'CheckRun',
                            name: 'mystery-conclusion',
                            status: 'COMPLETED',
                            conclusion: 'MYSTERY',
                            detailsUrl: null,
                            startedAt: null,
                            completedAt: null,
                          },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      };
    });

    await moduleMocker.mock('octokit', () => ({
      Octokit: mock(function () {
        return {
          graphql,
        };
      }),
    }));

    const { fetchPrCheckStatus } = await import('./pr_status.ts');

    await expect(fetchPrCheckStatus('owner', 'repo', 46)).rejects.toThrow(
      'Unhandled GitHub check status: BLOCKED'
    );
    await expect(fetchPrCheckStatus('owner', 'repo', 47)).rejects.toThrow(
      'Unhandled GitHub check conclusion: MYSTERY'
    );
  });

  test('fetchPrCheckStatus returns lightweight normalized checks', async () => {
    const graphql = mock(async () => ({
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: 'PENDING',
                    contexts: {
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          name: 'lint',
                          status: 'IN_PROGRESS',
                          conclusion: null,
                          detailsUrl: 'https://example.com/checks/lint',
                          startedAt: '2026-03-20T00:10:00.000Z',
                          completedAt: null,
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    }));

    await moduleMocker.mock('octokit', () => ({
      Octokit: mock(function () {
        return {
          graphql,
        };
      }),
    }));

    const { fetchPrCheckStatus } = await import('./pr_status.ts');
    const result = await fetchPrCheckStatus('owner', 'repo', 43);

    expect(result).toEqual({
      checks: [
        {
          name: 'lint',
          status: 'in_progress',
          conclusion: null,
          detailsUrl: 'https://example.com/checks/lint',
          startedAt: '2026-03-20T00:10:00.000Z',
          completedAt: null,
          source: 'check_run',
        },
      ],
      checkRollupState: 'pending',
    });
  });

  test('fetchPrCheckStatus filters null check context nodes', async () => {
    const graphql = mock(async () => ({
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: 'SUCCESS',
                    contexts: {
                      nodes: [
                        null,
                        {
                          __typename: 'StatusContext',
                          context: 'required-check',
                          state: 'SUCCESS',
                          targetUrl: 'https://example.com/status/required-check',
                          createdAt: '2026-03-20T00:20:00.000Z',
                        },
                        null,
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    }));

    await moduleMocker.mock('octokit', () => ({
      Octokit: mock(function () {
        return {
          graphql,
        };
      }),
    }));

    const { fetchPrCheckStatus } = await import('./pr_status.ts');

    await expect(fetchPrCheckStatus('owner', 'repo', 48)).resolves.toEqual({
      checks: [
        {
          name: 'required-check',
          status: 'completed',
          conclusion: 'success',
          detailsUrl: 'https://example.com/status/required-check',
          startedAt: null,
          completedAt: '2026-03-20T00:20:00.000Z',
          source: 'status_context',
        },
      ],
      checkRollupState: 'success',
    });
  });

  test('normalizes EXPECTED status contexts and handles missing check rollups', async () => {
    const graphql = mock(async (_query: string, variables: { prNumber: number }) => {
      if (variables.prNumber === 44) {
        return {
          repository: {
            pullRequest: {
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        state: 'EXPECTED',
                        contexts: {
                          nodes: [
                            {
                              __typename: 'StatusContext',
                              context: 'required-ci',
                              state: 'EXPECTED',
                              targetUrl: 'https://example.com/status/required-ci',
                              createdAt: '2026-03-20T00:05:00.000Z',
                            },
                            {
                              __typename: 'CheckRun',
                              name: 'bootstrap',
                              status: 'COMPLETED',
                              conclusion: 'STARTUP_FAILURE',
                              detailsUrl: null,
                              startedAt: '2026-03-20T00:00:00.000Z',
                              completedAt: '2026-03-20T00:01:00.000Z',
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        };
      }

      return {
        repository: {
          pullRequest: {
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: null,
                  },
                },
              ],
            },
          },
        },
      };
    });

    await moduleMocker.mock('octokit', () => ({
      Octokit: mock(function () {
        return {
          graphql,
        };
      }),
    }));

    const { fetchPrCheckStatus } = await import('./pr_status.ts');

    await expect(fetchPrCheckStatus('owner', 'repo', 44)).resolves.toEqual({
      checks: [
        {
          name: 'required-ci',
          status: 'pending',
          conclusion: null,
          detailsUrl: 'https://example.com/status/required-ci',
          startedAt: null,
          completedAt: null,
          source: 'status_context',
        },
        {
          name: 'bootstrap',
          status: 'completed',
          conclusion: 'startup_failure',
          detailsUrl: null,
          startedAt: '2026-03-20T00:00:00.000Z',
          completedAt: '2026-03-20T00:01:00.000Z',
          source: 'check_run',
        },
      ],
      checkRollupState: 'expected',
    });

    await expect(fetchPrCheckStatus('owner', 'repo', 45)).resolves.toEqual({
      checks: [],
      checkRollupState: null,
    });
  });

  test('throws when the requested PR is missing', async () => {
    await moduleMocker.mock('octokit', () => ({
      Octokit: mock(function () {
        return {
          graphql: mock(async () => ({
            repository: {
              pullRequest: null,
            },
          })),
        };
      }),
    }));

    const { fetchPrFullStatus } = await import('./pr_status.ts');

    await expect(fetchPrFullStatus('owner', 'repo', 99)).rejects.toThrow(
      'Pull request owner/repo#99 not found'
    );
  });
});
