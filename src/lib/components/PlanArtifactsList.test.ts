import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

import type { PlanArtifactWithTransferState } from '$tim/artifacts/service.js';
import PlanArtifactsList from './PlanArtifactsList.svelte';

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

describe('PlanArtifactsList', () => {
  test('renders artifact filename, size, and message', () => {
    const { body } = render(PlanArtifactsList, {
      props: { artifacts: [makeArtifact()] },
    });
    expect(body).toContain('screenshot.png');
    expect(body).toContain('Before fix');
    expect(body).toContain('KB');
  });

  test('renders <img> thumbnail for image mime types', () => {
    const { body } = render(PlanArtifactsList, {
      props: { artifacts: [makeArtifact()] },
    });
    expect(body).toContain('<img');
    expect(body).toContain('/api/artifacts/11111111-1111-1111-1111-111111111111');
  });

  test('does not render <img> for non-image mime types', () => {
    const { body } = render(PlanArtifactsList, {
      props: {
        artifacts: [
          makeArtifact({
            uuid: '22222222-2222-2222-2222-222222222222',
            filename: 'log.txt',
            mimeType: 'text/plain',
          }),
        ],
      },
    });
    expect(body).not.toContain('<img');
    expect(body).toContain('log.txt');
  });

  test('does not render <img> for SVG artifacts', () => {
    const { body } = render(PlanArtifactsList, {
      props: {
        artifacts: [
          makeArtifact({
            uuid: '77777777-7777-7777-7777-777777777777',
            filename: 'unsafe.svg',
            mimeType: 'image/svg+xml',
          }),
        ],
      },
    });
    expect(body).not.toContain('<img');
    expect(body).toContain('unsafe.svg');
    expect(body).toContain('href="/api/artifacts/77777777-7777-7777-7777-777777777777"');
  });

  test('shows Sync in progress badge when file is missing', () => {
    const { body } = render(PlanArtifactsList, {
      props: {
        artifacts: [makeArtifact({ transferState: 'file-missing' })],
      },
    });
    expect(body).toContain('Sync in progress');
  });

  test('does not render image thumbnail while image bytes are missing', () => {
    const { body } = render(PlanArtifactsList, {
      props: {
        artifacts: [makeArtifact({ transferState: 'file-missing' })],
      },
    });
    expect(body).not.toContain('<img');
    expect(body).toContain('screenshot.png');
    expect(body).toContain('Sync in progress');
  });

  test('shows Transfer failed badge for failed transfers', () => {
    const { body } = render(PlanArtifactsList, {
      props: {
        artifacts: [makeArtifact({ transferState: 'failed' })],
      },
    });
    expect(body).toContain('Transfer failed');
  });

  test('renders empty state when no active artifacts', () => {
    const { body } = render(PlanArtifactsList, {
      props: { artifacts: [] },
    });
    expect(body).toContain('No artifacts yet');
  });

  test('hides soft-deleted artifacts by default', () => {
    pageState.url = new URL('http://localhost/projects/1/plans/1');
    const { body } = render(PlanArtifactsList, {
      props: {
        artifacts: [
          makeArtifact({
            uuid: '33333333-3333-3333-3333-333333333333',
            filename: 'old.png',
            deletedAt: '2026-05-10T10:00:00.000Z',
          }),
        ],
      },
    });
    expect(body).not.toContain('old.png');
    expect(body).toContain('No artifacts yet');
    expect(body).not.toContain('checked');
  });

  test('shows soft-deleted artifacts when query param is set', () => {
    pageState.url = new URL('http://localhost/projects/1/plans/1?includeDeletedArtifacts=1');
    const { body } = render(PlanArtifactsList, {
      props: {
        artifacts: [
          makeArtifact({
            uuid: '33333333-3333-3333-3333-333333333333',
            filename: 'old.png',
            deletedAt: '2026-05-10T10:00:00.000Z',
          }),
        ],
      },
    });
    expect(body).toContain('old.png');
    expect(body).toContain('Deleted');
    expect(body).toContain('checked');
    // reset for other tests
    pageState.url = new URL('http://localhost/projects/1/plans/1');
  });

  test('Delete button is present for active artifacts', () => {
    pageState.url = new URL('http://localhost/projects/1/plans/1');
    const { body } = render(PlanArtifactsList, {
      props: { artifacts: [makeArtifact()] },
    });
    expect(body).toContain('aria-label="Delete artifact"');
    expect(body).not.toContain('aria-label="Restore artifact"');
  });

  test('Restore button is present for soft-deleted artifacts', () => {
    pageState.url = new URL('http://localhost/projects/1/plans/1?includeDeletedArtifacts=1');
    const { body } = render(PlanArtifactsList, {
      props: {
        artifacts: [makeArtifact({ deletedAt: '2026-05-10T10:00:00.000Z' })],
      },
    });
    expect(body).toContain('aria-label="Restore artifact"');
    pageState.url = new URL('http://localhost/projects/1/plans/1');
  });

  test('does not render a download link for soft-deleted artifacts', () => {
    pageState.url = new URL('http://localhost/projects/1/plans/1?includeDeletedArtifacts=1');
    const { body } = render(PlanArtifactsList, {
      props: {
        artifacts: [
          makeArtifact({
            uuid: '44444444-4444-4444-4444-444444444444',
            filename: 'old.png',
            deletedAt: '2026-05-10T10:00:00.000Z',
          }),
        ],
      },
    });
    // Filename is present as plain text, but no anchor/img to /api/artifacts/<uuid>
    expect(body).toContain('old.png');
    expect(body).not.toContain('/api/artifacts/44444444-4444-4444-4444-444444444444');
    expect(body).not.toContain('<img');
    pageState.url = new URL('http://localhost/projects/1/plans/1');
  });

  test('does not render a download link or thumbnail when file is missing', () => {
    const { body } = render(PlanArtifactsList, {
      props: {
        artifacts: [
          makeArtifact({
            uuid: '55555555-5555-5555-5555-555555555555',
            transferState: 'file-missing',
          }),
        ],
      },
    });
    expect(body).toContain('screenshot.png');
    expect(body).toContain('Sync in progress');
    expect(body).not.toContain('/api/artifacts/55555555-5555-5555-5555-555555555555');
    expect(body).not.toContain('<img');
  });

  test('renders download link for active artifacts with present bytes', () => {
    const { body } = render(PlanArtifactsList, {
      props: {
        artifacts: [
          makeArtifact({
            uuid: '66666666-6666-6666-6666-666666666666',
            mimeType: 'text/plain',
            filename: 'log.txt',
          }),
        ],
      },
    });
    expect(body).toContain('href="/api/artifacts/66666666-6666-6666-6666-666666666666"');
  });

  test('renders proof artifact links in browser-view mode', () => {
    const { body } = render(PlanArtifactsList, {
      props: {
        artifacts: [
          makeArtifact({
            uuid: '88888888-8888-8888-8888-888888888888',
            mimeType: 'text/markdown',
            filename: 'report.md',
            message: 'tim-proof:run-1',
          }),
        ],
      },
    });

    expect(body).toContain('href="/api/artifacts/88888888-8888-8888-8888-888888888888?view=1"');
  });

  test('keeps non-proof artifact links on the regular artifact endpoint', () => {
    const { body } = render(PlanArtifactsList, {
      props: {
        artifacts: [
          makeArtifact({
            uuid: '99999999-9999-9999-9999-999999999999',
            mimeType: 'text/plain',
            filename: 'notes.txt',
            message: 'manual note',
          }),
        ],
      },
    });

    expect(body).toContain('href="/api/artifacts/99999999-9999-9999-9999-999999999999"');
    expect(body).not.toContain('99999999-9999-9999-9999-999999999999?view=1');
  });
});
