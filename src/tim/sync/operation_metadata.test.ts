import { describe, expect, test } from 'vitest';
import {
  getProjectionPlanRefUuids,
  getSyncOperationPlanRefs,
  SYNC_OPERATION_METADATA,
} from './operation_metadata.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const ARTIFACT_UUID = '33333333-3333-4333-8333-333333333333';

describe('sync operation metadata', () => {
  test('registers artifact operations as plan_artifact metadata', () => {
    for (const type of [
      'plan_artifact.attach',
      'plan_artifact.soft_delete',
      'plan_artifact.restore',
      'plan_artifact.hard_delete',
    ] as const) {
      expect(SYNC_OPERATION_METADATA[type]).toEqual({
        entity: 'plan_artifact',
        baseRevisionTarget: 'plan',
      });
    }
  });

  test('indexes artifact operations by owning plan for projection rebuilds', () => {
    for (const type of [
      'plan_artifact.attach',
      'plan_artifact.soft_delete',
      'plan_artifact.restore',
      'plan_artifact.hard_delete',
    ] as const) {
      const payload = {
        type,
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        artifactUuid: ARTIFACT_UUID,
        ...(type === 'plan_artifact.attach'
          ? {
              filename: 'screenshot.png',
              mimeType: 'image/png',
              size: 1234,
              sha256: 'abc123',
            }
          : {}),
      };

      expect(getSyncOperationPlanRefs(payload)).toEqual([{ planUuid: PLAN_UUID, role: 'target' }]);
      expect(getProjectionPlanRefUuids(payload)).toEqual([PLAN_UUID]);
    }
  });
});
