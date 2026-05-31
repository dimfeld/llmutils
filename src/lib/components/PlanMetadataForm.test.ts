import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

import type { PlanPickerOption } from '$lib/server/plan_picker_queries.js';
import PlanMetadataForm from './PlanMetadataForm.svelte';

vi.mock('$lib/remote/plan_picker.remote.js', () => ({
  searchPlanPicker: vi.fn(async () => []),
}));

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

function renderForm(props: Partial<Parameters<typeof PlanMetadataForm>[0]['props']> = {}): string {
  const { body } = render(PlanMetadataForm, {
    props: {
      projectId: 7,
      mode: 'create',
      onsubmit: vi.fn(),
      ...props,
    },
  });
  return body;
}

describe('PlanMetadataForm', () => {
  test('renders create defaults and blocks submission while the title is blank', () => {
    const body = renderForm();

    expect(body).toContain('id="plan-title"');
    expect(body).toContain('aria-invalid="true"');
    expect(body).toContain('value="medium" selected');
    expect(body).toContain('value="pending" selected');
    expect(body).toContain('disabled');
    expect(body).toContain('Create');
  });

  test('offers persisted raw statuses only', () => {
    const body = renderForm();

    for (const status of [
      'pending',
      'in_progress',
      'needs_review',
      'reviewed',
      'done',
      'cancelled',
      'deferred',
    ]) {
      expect(body).toContain(`value="${status}"`);
    }
    expect(body).not.toContain('value="ready"');
    expect(body).not.toContain('value="blocked"');
    expect(body).not.toContain('value="recently_done"');
  });

  test('enables submission once the initial title is valid', () => {
    const body = renderForm({
      initialValue: {
        title: 'New web plan',
      },
    });

    expect(body).toContain('value="New web plan"');
    expect(body).not.toContain('aria-invalid="true"');
    expect(body).not.toContain('<button type="submit" disabled');
  });

  test('renders pending and error states without clearing entered values', () => {
    const body = renderForm({
      submitting: true,
      error: 'Invalid tag: blocked',
      initialValue: {
        title: 'Preserved title',
        goal: 'Preserved goal',
      },
    });

    expect(body).toContain('Preserved title');
    expect(body).toContain('Preserved goal');
    expect(body).toContain('Create...');
    expect(body).toContain('Invalid tag: blocked');
    expect(body).toContain('type="submit" disabled');
  });

  test('renders initially selected parent, base plan, and dependencies', () => {
    const body = renderForm({
      initialValue: {
        title: 'Related plan',
        parent: pickerOption('parent-uuid', 10, 'Parent plan'),
        basePlan: pickerOption('base-uuid', 11, 'Base plan'),
        dependencies: [pickerOption('dependency-uuid', 12, 'Dependency plan')],
      },
    });

    expect(body).toContain('#10: Parent plan');
    expect(body).toContain('#11: Base plan');
    expect(body).toContain('#12: Dependency plan');
    expect(body).toContain('aria-label="Clear Parent Plan"');
    expect(body).toContain('aria-label="Clear Base Plan"');
    expect(body).toContain('aria-label="Remove dependency #12"');
  });
});
