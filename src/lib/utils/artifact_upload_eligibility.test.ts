import { describe, expect, test } from 'vitest';

import { hasUploadableArtifacts } from './artifact_upload_eligibility.js';

describe('hasUploadableArtifacts', () => {
  test('returns true when the plan has a non-deleted artifact', () => {
    expect(hasUploadableArtifacts({ artifacts: [{ deletedAt: null }] })).toBe(true);
    expect(
      hasUploadableArtifacts({
        artifacts: [{ deletedAt: null }, { deletedAt: null }],
      })
    ).toBe(true);
  });

  test('returns false when all artifacts are deleted', () => {
    expect(
      hasUploadableArtifacts({
        artifacts: [
          { deletedAt: '2026-06-01T12:00:00.000Z' },
          { deletedAt: '2026-06-02T12:00:00.000Z' },
        ],
      })
    ).toBe(false);
  });

  test('returns false when the plan has an empty artifact list', () => {
    expect(hasUploadableArtifacts({ artifacts: [] })).toBe(false);
  });

  test('returns false when artifacts are null or undefined', () => {
    expect(hasUploadableArtifacts({ artifacts: null })).toBe(false);
    expect(hasUploadableArtifacts({})).toBe(false);
  });

  test('returns false when the plan is null or undefined', () => {
    expect(hasUploadableArtifacts(null)).toBe(false);
    expect(hasUploadableArtifacts(undefined)).toBe(false);
  });

  test('returns true when at least one artifact is non-deleted', () => {
    expect(
      hasUploadableArtifacts({
        artifacts: [
          { deletedAt: '2026-06-01T12:00:00.000Z' },
          { deletedAt: null },
          { deletedAt: '2026-06-02T12:00:00.000Z' },
        ],
      })
    ).toBe(true);
  });
});
