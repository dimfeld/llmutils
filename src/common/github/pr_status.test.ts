import { afterEach, describe, expect, test, vi } from 'vitest';
import * as octokitModule from './octokit.js';

// Mock the octokit module
vi.mock('./octokit.js', () => ({
  getOctokit: vi.fn(),
}));

describe('common/github/pr_status', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('fetchPrFullStatus normalizes checks, reviews, and labels', async () => {
    const graphql = vi.fn(async () => ({
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

    const mockGetOctokit = vi.mocked(octokitModule.getOctokit);
    mockGetOctokit.mockReturnValue({
      graphql,
    });

    const { fetchPrFullStatus } = await import('./pr_status.ts');
    const result = await fetchPrFullStatus('owner', 'repo', 42);

    expect(result).toEqual({
      author: null,
      number: 42,
      author: null,
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
    const graphql = vi.fn(async () => ({
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

    const mockGetOctokit = vi.mocked(octokitModule.getOctokit);
    mockGetOctokit.mockReturnValue({
      graphql,
    });

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

  test('warns and falls back for unknown enum values', async () => {
    const warn = vi.fn(() => {});
    const originalWarn = console.warn;
    console.warn = warn;

    try {
      const graphql = vi.fn(async (_query: string, variables: { prNumber: number }) => {
        if (variables.prNumber === 46) {
          return {
            repository: {
              pullRequest: {
                number: 46,
                title: 'Unknown PR state fallback',
                state: 'SUPER_OPEN',
                isDraft: false,
                mergeable: 'MERGEABLE',
                mergedAt: null,
                headRefOid: 'ghi789',
                baseRefName: 'main',
                headRefName: 'feature/unknown-pr-state',
                reviewDecision: null,
                labels: {
                  nodes: [],
                },
                reviews: {
                  nodes: [],
                },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          state: 'PENDING',
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
          };
        }

        if (variables.prNumber === 47) {
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

        if (variables.prNumber === 48) {
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
        }

        if (variables.prNumber === 49) {
          return {
            repository: {
              pullRequest: {
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          state: 'MYSTERY',
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
          };
        }

        if (variables.prNumber === 51) {
          return {
            repository: {
              pullRequest: {
                number: 51,
                title: 'Unknown review decision fallback',
                state: 'OPEN',
                isDraft: false,
                mergeable: 'MERGEABLE',
                mergedAt: null,
                headRefOid: 'jkl012',
                baseRefName: 'main',
                headRefName: 'feature/unknown-review-decision',
                reviewDecision: 'MYSTERY_DECISION',
                labels: {
                  nodes: [],
                },
                reviews: {
                  nodes: [],
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
          };
        }

        if (variables.prNumber === 52) {
          return {
            repository: {
              pullRequest: {
                number: 52,
                title: 'Unknown review state fallback',
                state: 'OPEN',
                isDraft: false,
                mergeable: 'MERGEABLE',
                mergedAt: null,
                headRefOid: 'mno345',
                baseRefName: 'main',
                headRefName: 'feature/unknown-review-state',
                reviewDecision: 'APPROVED',
                labels: {
                  nodes: [],
                },
                reviews: {
                  nodes: [
                    {
                      author: { login: 'reviewer-1' },
                      state: 'MYSTERY_REVIEW_STATE',
                      submittedAt: '2026-03-20T00:06:00.000Z',
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
          };
        }

        if (variables.prNumber === 53) {
          return {
            repository: {
              pullRequest: {
                number: 53,
                title: 'Unknown mergeable fallback',
                state: 'OPEN',
                isDraft: false,
                mergeable: 'MYSTERY_MERGEABLE',
                mergedAt: null,
                headRefOid: 'pqr678',
                baseRefName: 'main',
                headRefName: 'feature/unknown-mergeable',
                reviewDecision: 'APPROVED',
                labels: {
                  nodes: [],
                },
                reviews: {
                  nodes: [],
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
                        state: 'PENDING',
                        contexts: {
                          nodes: [
                            {
                              __typename: 'StatusContext',
                              context: 'legacy-status',
                              state: 'BLOCKED',
                              targetUrl: null,
                              createdAt: '2026-03-20T00:05:00.000Z',
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

      const mockGetOctokit = vi.mocked(octokitModule.getOctokit);
      mockGetOctokit.mockReturnValue({
        graphql,
      });

      const { fetchPrCheckStatus, fetchPrFullStatus } = await import('./pr_status.ts');

      await expect(fetchPrFullStatus('owner', 'repo', 46)).resolves.toMatchObject({
        state: 'open',
      });
      await expect(fetchPrCheckStatus('owner', 'repo', 47)).resolves.toEqual({
        checks: [
          {
            name: 'mystery-check',
            status: 'pending',
            conclusion: null,
            detailsUrl: null,
            startedAt: null,
            completedAt: null,
            source: 'check_run',
          },
        ],
        checkRollupState: 'pending',
      });
      await expect(fetchPrCheckStatus('owner', 'repo', 48)).resolves.toEqual({
        checks: [
          {
            name: 'mystery-conclusion',
            status: 'completed',
            conclusion: null,
            detailsUrl: null,
            startedAt: null,
            completedAt: null,
            source: 'check_run',
          },
        ],
        checkRollupState: 'failure',
      });
      await expect(fetchPrCheckStatus('owner', 'repo', 49)).resolves.toEqual({
        checks: [],
        checkRollupState: null,
      });
      await expect(fetchPrCheckStatus('owner', 'repo', 50)).resolves.toEqual({
        checks: [
          {
            name: 'legacy-status',
            status: 'pending',
            conclusion: null,
            detailsUrl: null,
            startedAt: null,
            completedAt: null,
            source: 'status_context',
          },
        ],
        checkRollupState: 'pending',
      });
      await expect(fetchPrFullStatus('owner', 'repo', 51)).resolves.toMatchObject({
        reviewDecision: 'REVIEW_REQUIRED',
      });
      await expect(fetchPrFullStatus('owner', 'repo', 52)).resolves.toMatchObject({
        reviews: [
          {
            author: 'reviewer-1',
            state: 'COMMENTED',
            submittedAt: '2026-03-20T00:06:00.000Z',
          },
        ],
      });
      await expect(fetchPrFullStatus('owner', 'repo', 53)).resolves.toMatchObject({
        mergeable: 'UNKNOWN',
      });

      expect(warn).toHaveBeenCalledTimes(8);
      expect(warn).toHaveBeenNthCalledWith(
        1,
        'Unknown GitHub PR state: SUPER_OPEN. Falling back to open.'
      );
      expect(warn).toHaveBeenNthCalledWith(
        2,
        'Unknown GitHub check status: BLOCKED. Falling back to pending.'
      );
      expect(warn).toHaveBeenNthCalledWith(
        3,
        'Unknown GitHub check conclusion: MYSTERY. Falling back to null.'
      );
      expect(warn).toHaveBeenNthCalledWith(
        4,
        'Unknown GitHub check rollup state: MYSTERY. Falling back to null.'
      );
      expect(warn).toHaveBeenNthCalledWith(
        5,
        'Unknown GitHub status context state: BLOCKED. Falling back to pending.'
      );
      expect(warn).toHaveBeenNthCalledWith(
        6,
        'Unknown GitHub review decision: MYSTERY_DECISION. Falling back to REVIEW_REQUIRED.'
      );
      expect(warn).toHaveBeenNthCalledWith(
        7,
        'Unknown GitHub review state: MYSTERY_REVIEW_STATE. Falling back to COMMENTED.'
      );
      expect(warn).toHaveBeenNthCalledWith(
        8,
        'Unknown GitHub mergeable state: MYSTERY_MERGEABLE. Falling back to UNKNOWN.'
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test('fetchPrCheckStatus returns lightweight normalized checks', async () => {
    const graphql = vi.fn(async () => ({
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

    const mockGetOctokit = vi.mocked(octokitModule.getOctokit);
    mockGetOctokit.mockReturnValue({
      graphql,
    });

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
    const graphql = vi.fn(async () => ({
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

    const mockGetOctokit = vi.mocked(octokitModule.getOctokit);
    mockGetOctokit.mockReturnValue({
      graphql,
    });

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
    const graphql = vi.fn(async (_query: string, variables: { prNumber: number }) => {
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

    const mockGetOctokit = vi.mocked(octokitModule.getOctokit);
    mockGetOctokit.mockReturnValue({
      graphql,
    });

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
    const mockGetOctokit = vi.mocked(octokitModule.getOctokit);
    mockGetOctokit.mockReturnValue({
      graphql: vi.fn(async () => ({
        repository: {
          pullRequest: null,
        },
      })),
    });

    const { fetchPrFullStatus } = await import('./pr_status.ts');

    await expect(fetchPrFullStatus('owner', 'repo', 99)).rejects.toThrow(
      'Pull request owner/repo#99 not found'
    );
  });

  test('fetchPrMergeableAndReviewDecision normalizes targeted fields', async () => {
    const graphql = mock(async () => ({
      repository: {
        pullRequest: {
          mergeable: 'CONFLICTING',
          reviewDecision: 'CHANGES_REQUESTED',
        },
      },
    }));

    await moduleMocker.mock('./octokit.js', () => ({
      getOctokit: () => ({
        graphql,
      }),
    }));

    const { fetchPrMergeableAndReviewDecision } = await import('./pr_status.ts');
    await expect(fetchPrMergeableAndReviewDecision('owner', 'repo', 77)).resolves.toEqual({
      mergeable: 'CONFLICTING',
      reviewDecision: 'CHANGES_REQUESTED',
    });
  });
});
