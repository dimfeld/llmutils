import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';

import PrCheckRunList from './PrCheckRunList.svelte';

function makeCheck(overrides: Partial<{ id: number; name: string; status: string; conclusion: string | null; details_url: string | null }> = {}) {
  return {
    id: 1,
    pr_status_id: 1,
    name: 'CI / build',
    source: 'check_run' as const,
    status: 'completed',
    conclusion: 'success',
    details_url: 'https://example.com/check',
    started_at: '2026-03-18T10:00:00.000Z',
    completed_at: '2026-03-18T10:01:00.000Z',
    ...overrides,
  };
}

describe('PrCheckRunList', () => {
  test('renders a Required badge for required checks only', () => {
    const { body } = render(PrCheckRunList, {
      props: {
        checks: [makeCheck(), makeCheck({ id: 2, name: 'CI / optional' })],
        requiredCheckNames: ['CI / build'],
      },
    });

    expect(body).toContain('CI / build');
    expect(body).toContain('CI / optional');
    expect(body).toContain('Required');
  });

  test('does not render a Required badge when no required checks are provided', () => {
    const { body } = render(PrCheckRunList, {
      props: {
        checks: [makeCheck()],
        requiredCheckNames: [],
      },
    });

    expect(body).not.toContain('Required');
  });
});
