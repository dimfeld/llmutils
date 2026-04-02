import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';

import PrList from './PrList.svelte';

function createPr(prNumber: number, title: string) {
  return {
    projectId: 123,
    status: {
      pr_number: prNumber,
      title,
      head_branch: `feature/${prNumber}`,
    },
    linkedPlans: [],
    currentUserReviewRequestLabel: null,
    checks: [],
    reviews: [],
    reviewRequests: [],
    labels: [],
  };
}

describe('PrList', () => {
  test('shows a neutral section label when username is unavailable', () => {
    const { body } = render(PrList, {
      props: {
        authored: [createPr(1, 'Webhook cached PR')],
        reviewing: [],
        username: null,
        selectedPrKey: null,
      },
    });

    expect(body).toContain('All Pull Requests');
    expect(body).not.toContain('My PRs');
  });
});
