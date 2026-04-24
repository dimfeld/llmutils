import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';
import ReviewGuideLinkedPlans from './ReviewGuideLinkedPlans.svelte';

describe('ReviewGuideLinkedPlans', () => {
  test('renders direct links to the linked plans', () => {
    const { body } = render(ReviewGuideLinkedPlans, {
      props: {
        projectId: '7',
        linkedPlans: [
          { planUuid: 'plan-20', planId: 20, title: 'Refactor parser' },
          { planUuid: 'plan-10', planId: 10, title: null },
        ],
      },
    });

    expect(body).toContain('Linked plans:');
    expect(body).toContain('href="/projects/7/plans/plan-10"');
    expect(body).toContain('href="/projects/7/plans/plan-20"');
    expect(body).toContain('Refactor parser');
  });
});
