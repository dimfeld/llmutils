import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';

import type { PrSummaryStatus } from '$lib/server/db_queries.js';
import PrStatusIndicator from './PrStatusIndicator.svelte';

function renderIndicator(status: PrSummaryStatus) {
  return render(PrStatusIndicator, { props: { status } });
}

describe('PrStatusIndicator', () => {
  test('renders green dot for passing status', () => {
    const { body } = renderIndicator('passing');
    expect(body).toContain('bg-green-500');
    expect(body).toContain('PR checks passing');
  });

  test('renders red dot for failing status', () => {
    const { body } = renderIndicator('failing');
    expect(body).toContain('bg-red-500');
    expect(body).toContain('PR checks failing');
  });

  test('renders yellow dot for pending status', () => {
    const { body } = renderIndicator('pending');
    expect(body).toContain('bg-yellow-500');
    expect(body).toContain('PR checks pending');
  });

  test('renders gray dot for none status', () => {
    const { body } = renderIndicator('none');
    expect(body).toContain('bg-gray-400');
    expect(body).toContain('No PR status');
  });

  test('renders as a small rounded dot', () => {
    const { body } = renderIndicator('passing');
    expect(body).toContain('rounded-full');
    expect(body).toContain('h-2');
    expect(body).toContain('w-2');
  });
});
