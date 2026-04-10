import { afterEach, describe, expect, test, vi } from 'vitest';
import * as octokitModule from './octokit.js';

vi.mock('./octokit.js', () => ({
  getOctokit: vi.fn(),
}));

describe('common/github/branch_merge_requirements', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('fetchBranchMergeRequirements merges legacy protection and rulesets', async () => {
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      if (
        route === 'GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks'
      ) {
        return {
          data: {
            strict: true,
            checks: [
              { context: 'test', app_id: 123 },
              { context: 'lint', app_id: -1 },
            ],
          },
        };
      }

      if (route === 'GET /repos/{owner}/{repo}/rules/branches/{branch}') {
        expect(params.page).toBe(1);
        return {
          data: [
            {
              type: 'required_status_checks',
              ruleset_id: 45,
              ruleset_name: 'Protect main',
              parameters: {
                strict_required_status_checks_policy: false,
                required_status_checks: [
                  { context: 'deploy', integration_id: 456 },
                  { context: 'lint', integration_id: null },
                ],
              },
            },
            {
              type: 'pull_request',
              ruleset_id: 45,
              ruleset_name: 'Protect main',
              parameters: {},
            },
          ],
        };
      }

      throw new Error(`Unexpected route: ${route}`);
    });

    vi.mocked(octokitModule.getOctokit).mockReturnValue({ request } as any);

    const { fetchBranchMergeRequirements } = await import('./branch_merge_requirements.ts');
    const result = await fetchBranchMergeRequirements('example', 'repo', 'main');

    expect(result).toEqual({
      owner: 'example',
      repo: 'repo',
      branchName: 'main',
      requirements: [
        {
          sourceKind: 'legacy_branch_protection',
          sourceId: 0,
          sourceName: null,
          strict: true,
          checks: [
            { context: 'lint', integrationId: -1 },
            { context: 'test', integrationId: 123 },
          ],
        },
        {
          sourceKind: 'ruleset',
          sourceId: 45,
          sourceName: 'Protect main',
          strict: false,
          checks: [
            { context: 'deploy', integrationId: 456 },
            { context: 'lint', integrationId: null },
          ],
        },
      ],
    });
  });

  test('fetchBranchMergeRequirements tolerates missing legacy protection', async () => {
    const request = vi.fn(async (route: string) => {
      if (
        route === 'GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks'
      ) {
        const error = new Error('Not Found') as Error & { status: number };
        error.status = 404;
        throw error;
      }

      return {
        data: [],
      };
    });

    vi.mocked(octokitModule.getOctokit).mockReturnValue({ request } as any);

    const { fetchBranchMergeRequirements } = await import('./branch_merge_requirements.ts');
    const result = await fetchBranchMergeRequirements('example', 'repo', 'main');

    expect(result.requirements).toEqual([]);
  });
});
