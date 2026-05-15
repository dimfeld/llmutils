import { describe, expect, test } from 'vitest';
import type { PlanSchema } from '../planSchema.js';
import { ensureReferences, fixReferenceMismatches, verifyReferences } from './references.js';

function createPlan(id: number, overrides: Partial<PlanSchema> = {}): PlanSchema {
  return {
    id,
    title: `Plan ${id}`,
    goal: `Goal ${id}`,
    status: 'pending',
    tasks: [],
    uuid: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    ...overrides,
  };
}

describe('plan reference utilities', () => {
  test('ensureReferences adds UUID references for basePlan', () => {
    const basePlan = createPlan(12);
    const plan = createPlan(20, { basePlan: 12 });

    const { updatedPlan } = ensureReferences(
      plan,
      new Map([
        [12, basePlan],
        [20, plan],
      ])
    );

    expect(updatedPlan.references).toEqual({
      12: basePlan.uuid,
    });
  });

  test('verifyReferences validates basePlan references', () => {
    const staleBasePlan = createPlan(12, { uuid: '00000000-0000-4000-8000-000000000999' });
    const renumberedBasePlan = createPlan(22, { uuid: '00000000-0000-4000-8000-000000000012' });
    const plan = createPlan(20, {
      basePlan: 12,
      references: {
        12: renumberedBasePlan.uuid!,
      },
    });

    const result = verifyReferences(
      plan,
      new Map([
        [12, staleBasePlan],
        [20, plan],
        [22, renumberedBasePlan],
      ]),
      new Map([[renumberedBasePlan.uuid!, 22]])
    );

    expect(result).toEqual({
      isValid: false,
      missingPlans: [],
      mismatches: [
        {
          referencedId: 12,
          expectedUuid: renumberedBasePlan.uuid,
          actualUuid: staleBasePlan.uuid,
          correctId: 22,
        },
      ],
    });
  });

  test('fixReferenceMismatches rewrites basePlan after renumbering', () => {
    const staleBasePlan = createPlan(12, { uuid: '00000000-0000-4000-8000-000000000999' });
    const renumberedBasePlan = createPlan(22, { uuid: '00000000-0000-4000-8000-000000000012' });
    const plan = createPlan(20, {
      basePlan: 12,
      references: {
        12: renumberedBasePlan.uuid!,
      },
    });
    const verificationResult = verifyReferences(
      plan,
      new Map([
        [12, staleBasePlan],
        [20, plan],
        [22, renumberedBasePlan],
      ]),
      new Map([[renumberedBasePlan.uuid!, 22]])
    );

    const fixedPlan = fixReferenceMismatches(plan, verificationResult);

    expect(fixedPlan.basePlan).toBe(22);
    expect(fixedPlan.references).toEqual({
      22: renumberedBasePlan.uuid,
    });
  });
});
