import { describe, expect, test } from 'vitest';

import { classifyArtifactPreview } from '$lib/utils/artifact_preview.js';
import type { PlanArtifactWithTransferState } from '$tim/artifacts/service.js';

function makeArtifact(
  overrides: Partial<PlanArtifactWithTransferState> = {}
): PlanArtifactWithTransferState {
  return {
    uuid: 'artifact-uuid',
    planUuid: 'plan-uuid',
    projectUuid: 'project-uuid',
    filename: 'artifact.txt',
    mimeType: 'text/plain',
    size: 100,
    sha256: 'sha',
    message: null,
    storagePath: '/tmp/artifact.txt',
    deletedAt: null,
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    revision: 1,
    transferState: null,
    ...overrides,
  };
}

describe('projects/[projectId]/plans/[planId]/artifacts/+page.server', () => {
  test('classifies sql octet-stream artifacts as source previews', () => {
    expect(
      classifyArtifactPreview(
        makeArtifact({
          filename: 'schema.sql',
          mimeType: 'application/octet-stream',
        })
      )
    ).toBe('source');
  });

  test('classifies oversized sql artifacts as too large for text preview', () => {
    expect(
      classifyArtifactPreview(
        makeArtifact({
          filename: 'schema.sql',
          mimeType: 'application/octet-stream',
          size: 6 * 1024 * 1024,
        })
      )
    ).toBe('too_large');
  });
});
