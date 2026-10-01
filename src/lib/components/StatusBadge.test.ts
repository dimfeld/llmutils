import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';

import StatusBadge from './StatusBadge.svelte';

describe('StatusBadge', () => {
  test('marks queued plans that are blocked by dependencies', () => {
    const { body } = render(StatusBadge, { props: { status: 'blocked', planStatus: 'queued' } });

    expect(body).toContain('Queued · Blocked');
    expect(body).toContain('title="Queued, but waiting on unfinished dependencies"');
    expect(body).toContain('bg-amber-100');
  });

  test('shows plain Blocked label for blocked plans that are not queued', () => {
    const { body } = render(StatusBadge, { props: { status: 'blocked', planStatus: 'pending' } });

    expect(body).toContain('Blocked');
    expect(body).not.toContain('Queued');
    expect(body).not.toContain('title=');
  });

  test('shows plain Queued label for unblocked queued plans', () => {
    const { body } = render(StatusBadge, { props: { status: 'queued', planStatus: 'queued' } });

    expect(body).toContain('Queued');
    expect(body).not.toContain('Blocked');
  });

  test('explicit label override wins', () => {
    const { body } = render(StatusBadge, {
      props: { status: 'blocked', planStatus: 'queued', label: 'Custom' },
    });

    expect(body).toContain('Custom');
    expect(body).not.toContain('Queued · Blocked');
  });
});
