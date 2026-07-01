import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

import PlanArtifactUploader from './PlanArtifactUploader.svelte';

vi.mock('$app/navigation', () => ({
  invalidateAll: vi.fn(),
}));

vi.mock('svelte-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('PlanArtifactUploader', () => {
  test('renders drag-drop zone, file input, and message input', () => {
    const { body } = render(PlanArtifactUploader, {
      props: { planUuid: 'plan-uuid', projectId: '123' },
    });
    expect(body).toContain('data-testid="artifact-uploader"');
    expect(body).toContain('data-testid="artifact-file-input"');
    expect(body).toContain('data-testid="artifact-message-input"');
    expect(body).toContain('role="button"');
    expect(body).toContain('aria-label="Upload artifact"');
    expect(body).toContain('multiple');
    expect(body).toContain('Drop files here');
    expect(body).toContain('max 25 MB each');
  });

  test('shows optional-message placeholder', () => {
    const { body } = render(PlanArtifactUploader, {
      props: { planUuid: 'plan-uuid' },
    });
    expect(body).toContain('Optional message');
  });

  test('renders the Reference artifact checkbox, checked by default', () => {
    const { body } = render(PlanArtifactUploader, {
      props: { planUuid: 'plan-uuid' },
    });
    expect(body).toContain('data-testid="artifact-reference-checkbox"');
    expect(body).toContain('Reference artifact');
    expect(body).toContain('checked');
  });
});
