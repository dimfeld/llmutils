import { describe, expect, test } from 'vitest';

import type { PlanPickerOption } from '$lib/server/plan_picker_queries.js';
import {
  normalizePlanMetadataFormPayload,
  parsePlanMetadataTags,
} from './plan_metadata_form_utils.js';

function pickerOption(uuid: string, planId: number, title: string): PlanPickerOption {
  return {
    uuid,
    projectId: 7,
    planId,
    title,
    status: 'pending',
    priority: 'medium',
    parentUuid: null,
    basePlanUuid: null,
  };
}

describe('plan metadata form utils', () => {
  test('normalizes comma-separated tags for submission', () => {
    expect(parsePlanMetadataTags(' Web, backend , WEB,  ,needs-review ')).toEqual([
      'web',
      'backend',
      'web',
      'needs-review',
    ]);
  });

  test('normalizes form state into the create command payload shape', () => {
    const parentPlan = pickerOption('parent-uuid', 10, 'Parent plan');
    const basePlan = pickerOption('base-uuid', 11, 'Base plan');
    const dependency = pickerOption('dependency-uuid', 12, 'Dependency plan');

    expect(
      normalizePlanMetadataFormPayload({
        title: '  Create plan UI  ',
        goal: '  Make the web flow work  ',
        note: '  Internal context  ',
        details: '  More detail  ',
        priority: 'high',
        status: 'needs_review',
        simple: true,
        tagsInput: ' Frontend, Web ',
        parentPlan,
        basePlan,
        dependencies: [dependency],
      })
    ).toEqual({
      title: 'Create plan UI',
      goal: 'Make the web flow work',
      note: 'Internal context',
      details: 'More detail',
      priority: 'high',
      status: 'needs_review',
      simple: true,
      tags: ['frontend', 'web'],
      parentUuid: 'parent-uuid',
      basePlanUuid: 'base-uuid',
      dependencyUuids: ['dependency-uuid'],
    });
  });

  test('preserves empty optional relationship fields as nulls and empty arrays', () => {
    expect(
      normalizePlanMetadataFormPayload({
        title: 'Standalone plan',
        goal: '',
        note: '',
        details: '',
        priority: 'medium',
        status: 'pending',
        simple: false,
        tagsInput: '',
        parentPlan: null,
        basePlan: null,
        dependencies: [],
      })
    ).toMatchObject({
      parentUuid: null,
      basePlanUuid: null,
      dependencyUuids: [],
      tags: [],
      note: '',
    });
  });
});
