import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { PlanArtifactWithTransferState } from '$tim/artifacts/service.js';

const { pageState } = vi.hoisted(() => ({
  pageState: {
    url: new URL('http://localhost/projects/1/plans/1'),
  },
}));

vi.mock('$app/state', () => ({
  page: pageState,
}));

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));

vi.mock('$lib/remote/artifact_actions.remote.js', () => ({
  softDeleteArtifact: vi.fn(),
  restoreArtifact: vi.fn(),
}));

vi.mock('svelte-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import PlanArtifactsList from './PlanArtifactsList.svelte';

function makeArtifact(
  overrides: Partial<PlanArtifactWithTransferState> = {}
): PlanArtifactWithTransferState {
  return {
    uuid: '11111111-1111-1111-1111-111111111111',
    planUuid: 'plan-uuid-1',
    projectUuid: 'project-uuid-1',
    filename: 'screenshot.png',
    mimeType: 'image/png',
    size: 1234,
    sha256: 'abc',
    message: 'Before fix',
    storagePath: '/tmp/artifacts/1.png',
    deletedAt: null,
    createdAt: '2026-05-12T10:00:00.000Z',
    updatedAt: '2026-05-12T10:00:00.000Z',
    revision: 1,
    transferState: 'synced',
    ...overrides,
  };
}

describe('PlanArtifactsList reference badge (browser)', () => {
  test('renders the Reference badge for a reference artifact and strips the prefix from the description', async () => {
    render(PlanArtifactsList, {
      props: {
        artifacts: [
          makeArtifact({
            uuid: 'bbbbbbbb-9999-9999-9999-999999999999',
            message: 'tim-reference:my notes',
          }),
        ],
      },
    });

    const badge = page.getByTestId('reference-badge');
    await expect.element(badge).toBeInTheDocument();
    await expect.element(badge).toHaveTextContent('Reference');
    await expect.element(page.getByText('my notes')).toBeInTheDocument();
    await expect.element(page.getByText('tim-reference:my notes')).not.toBeInTheDocument();
  });

  test('does not render the Reference badge for a plain artifact', async () => {
    render(PlanArtifactsList, {
      props: {
        artifacts: [
          makeArtifact({
            uuid: 'cccccccc-9999-9999-9999-999999999999',
            message: null,
          }),
        ],
      },
    });

    await expect.element(page.getByTestId('reference-badge')).not.toBeInTheDocument();
  });

  test('does not render the Reference badge for a proof artifact', async () => {
    render(PlanArtifactsList, {
      props: {
        artifacts: [
          makeArtifact({
            uuid: 'dddddddd-9999-9999-9999-999999999999',
            message: 'tim-proof:run-1',
          }),
        ],
      },
    });

    await expect.element(page.getByTestId('reference-badge')).not.toBeInTheDocument();
    await expect.element(page.getByText('Proof', { exact: true })).toBeInTheDocument();
  });
});
