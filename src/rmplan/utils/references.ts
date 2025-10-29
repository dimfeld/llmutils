import type { PlanSchema } from '../planSchema.ts';
import { writePlanFile } from '../plans.ts';

/**
 * Extracts all plan IDs referenced by a plan (parent, dependencies, discoveredFrom)
 */
export function getReferencedPlanIds(plan: PlanSchema): number[] {
  const ids: number[] = [];

  if (plan.parent !== undefined) {
    ids.push(plan.parent);
  }

  if (plan.dependencies && plan.dependencies.length > 0) {
    ids.push(...plan.dependencies);
  }

  if (plan.discoveredFrom !== undefined) {
    ids.push(plan.discoveredFrom);
  }

  // Return unique IDs
  return [...new Set(ids)];
}

/**
 * Ensures that a plan's references field contains entries for all referenced plans.
 * Generates UUIDs for referenced plans that don't have them.
 *
 * @param plan The plan to update references for
 * @param allPlans Map of all plans (id -> plan)
 * @returns Object with updated plan and array of plans that had UUIDs generated
 */
export function ensureReferences(
  plan: PlanSchema,
  allPlans: Map<number, PlanSchema>
): {
  updatedPlan: PlanSchema;
  plansWithGeneratedUuids: Array<{ id: number; uuid: string }>;
} {
  const referencedIds = getReferencedPlanIds(plan);
  const references = plan.references ? { ...plan.references } : {};
  const plansWithGeneratedUuids: Array<{ id: number; uuid: string }> = [];

  for (const id of referencedIds) {
    const referencedPlan = allPlans.get(id);
    if (!referencedPlan) {
      // Referenced plan doesn't exist - this is a validation error
      // but we don't handle it here. The validate command will catch it.
      continue;
    }

    // If the referenced plan doesn't have a UUID, generate one
    let uuid = referencedPlan.uuid;
    if (!uuid) {
      uuid = crypto.randomUUID();
      referencedPlan.uuid = uuid;
      plansWithGeneratedUuids.push({ id, uuid });
    }

    // Update or add the reference
    references[id] = uuid;
  }

  // Remove references to plans no longer referenced
  const referencedIdSet = new Set(referencedIds);
  for (const id of Object.keys(references)) {
    if (!referencedIdSet.has(Number(id))) {
      delete references[Number(id)];
    }
  }

  return {
    updatedPlan: {
      ...plan,
      references: Object.keys(references).length > 0 ? references : undefined,
    },
    plansWithGeneratedUuids,
  };
}

export interface ReferenceVerificationResult {
  /** True if all references are consistent */
  isValid: boolean;
  /** Mismatches found: { referencedId, expectedUuid, actualUuid, correctId } */
  mismatches: Array<{
    /** The ID currently stored in parent/dependencies/discoveredFrom */
    referencedId: number;
    /** The UUID stored in references field for that ID */
    expectedUuid: string;
    /** The actual UUID of the plan with referencedId (if exists) */
    actualUuid: string | undefined;
    /** The ID of the plan that has expectedUuid (if found) */
    correctId: number | undefined;
  }>;
  /** Plan IDs that don't exist in allPlans */
  missingPlans: number[];
}

/**
 * Verifies that a plan's references field matches the actual UUIDs of referenced plans.
 *
 * @param plan The plan to verify
 * @param allPlans Map of all plans (id -> plan)
 * @param uuidToId Map of UUID to plan ID for efficient lookups
 * @returns Verification result with any mismatches found
 */
export function verifyReferences(
  plan: PlanSchema,
  allPlans: Map<number, PlanSchema>,
  uuidToId: Map<string, number>
): ReferenceVerificationResult {
  const referencedIds = getReferencedPlanIds(plan);
  const references = plan.references || {};

  const mismatches: ReferenceVerificationResult['mismatches'] = [];
  const missingPlans: number[] = [];

  for (const id of referencedIds) {
    const referencedPlan = allPlans.get(id);
    if (!referencedPlan) {
      missingPlans.push(id);
      continue;
    }

    const expectedUuid = references[id];
    const actualUuid = referencedPlan.uuid;

    // Check if UUID matches
    if (expectedUuid && actualUuid && expectedUuid !== actualUuid) {
      // UUID mismatch - the referenced plan was likely renumbered
      // Find the plan that has the expected UUID
      const correctId = uuidToId.get(expectedUuid);

      mismatches.push({
        referencedId: id,
        expectedUuid,
        actualUuid,
        correctId,
      });
    }
  }

  return {
    isValid: mismatches.length === 0 && missingPlans.length === 0,
    mismatches,
    missingPlans,
  };
}

/**
 * Fixes reference mismatches by updating parent/dependencies/discoveredFrom
 * to point to the correct plan IDs based on UUIDs.
 *
 * @param plan The plan to fix
 * @param verificationResult The result from verifyReferences
 * @returns Updated plan with corrected references
 */
export function fixReferenceMismatches(
  plan: PlanSchema,
  verificationResult: ReferenceVerificationResult
): PlanSchema {
  if (verificationResult.isValid) {
    return plan;
  }

  let updatedPlan = { ...plan };

  // Build a mapping of old ID -> new ID
  const idMapping = new Map<number, number>();
  for (const mismatch of verificationResult.mismatches) {
    if (mismatch.correctId !== undefined) {
      idMapping.set(mismatch.referencedId, mismatch.correctId);
    }
  }

  // Update parent
  if (updatedPlan.parent !== undefined && idMapping.has(updatedPlan.parent)) {
    updatedPlan.parent = idMapping.get(updatedPlan.parent);
  }

  // Update dependencies
  if (updatedPlan.dependencies && updatedPlan.dependencies.length > 0) {
    updatedPlan.dependencies = updatedPlan.dependencies.map((id) => idMapping.get(id) ?? id);
  }

  // Update discoveredFrom
  if (updatedPlan.discoveredFrom !== undefined && idMapping.has(updatedPlan.discoveredFrom)) {
    updatedPlan.discoveredFrom = idMapping.get(updatedPlan.discoveredFrom);
  }

  // Update references field with new IDs
  if (updatedPlan.references) {
    const newReferences: Record<number, string> = {};
    for (const [idStr, uuid] of Object.entries(updatedPlan.references)) {
      const id = Number(idStr);
      const newId = idMapping.get(id) ?? id;
      newReferences[newId] = uuid;
    }
    updatedPlan.references = newReferences;
  }

  return updatedPlan;
}

/**
 * Updates a plan's references and writes it to disk.
 * This is a convenience function that combines ensureReferences with writePlanFile.
 *
 * @param plan The plan to update and write
 * @param allPlans Map of all plans (for looking up UUIDs)
 * @param options Options to pass to writePlanFile
 * @returns Array of plans that had UUIDs generated
 */
export async function updateAndWritePlan(
  plan: PlanSchema & { filename: string },
  allPlans: Map<number, PlanSchema>,
  options?: { skipUpdatedAt?: boolean }
): Promise<Array<{ id: number; uuid: string }>> {
  const { updatedPlan, plansWithGeneratedUuids } = ensureReferences(plan, allPlans);
  await writePlanFile(plan.filename, updatedPlan, options);
  return plansWithGeneratedUuids;
}
