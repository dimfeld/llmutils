import type { PlanSchema } from '../planSchema.ts';
import { readAllPlans, readPlanFile, writePlanFile } from '../plans.ts';

export interface UuidIssue {
  planId: number;
  filename: string;
}

export interface UuidFixResult {
  generated: Array<{ planId: number; uuid: string; filename: string }>;
  errors: string[];
}

export interface ReferenceIssue {
  planId: number;
  filename: string;
  verificationResult: ReferenceVerificationResult;
}

export interface ReferenceFixResult {
  updated: Array<{ planId: number; filename: string }>;
  errors: string[];
}

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
 * Detects plans without UUIDs
 */
export function detectMissingUuids(
  planMap: Map<number, PlanSchema & { filename: string }>
): UuidIssue[] {
  const issues: UuidIssue[] = [];

  for (const [planId, plan] of planMap.entries()) {
    if (!plan.uuid) {
      issues.push({ planId, filename: plan.filename });
    }
  }

  return issues;
}

/**
 * Generates UUIDs for plans that don't have them
 */
export async function fixMissingUuids(issues: UuidIssue[]): Promise<UuidFixResult> {
  const generated: UuidFixResult['generated'] = [];
  const errors: string[] = [];

  for (const issue of issues) {
    try {
      const plan = await readPlanFile(issue.filename);
      const uuid = crypto.randomUUID();
      plan.uuid = uuid;
      await writePlanFile(issue.filename, plan, { skipUpdatedAt: true });
      generated.push({ planId: issue.planId, uuid, filename: issue.filename });
    } catch (error) {
      errors.push(
        `Failed to generate UUID for plan ${issue.planId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { generated, errors };
}

/**
 * Detects plans with incomplete or inconsistent references
 */
export function detectReferenceIssues(
  planMap: Map<number, PlanSchema & { filename: string }>,
  uuidToId: Map<string, number>
): ReferenceIssue[] {
  const issues: ReferenceIssue[] = [];

  for (const [planId, plan] of planMap.entries()) {
    const verificationResult = verifyReferences(plan, planMap, uuidToId);
    if (!verificationResult.isValid) {
      issues.push({ planId, filename: plan.filename, verificationResult });
    }
  }

  return issues;
}

/**
 * Fixes reference issues by updating parent/dependencies/discoveredFrom
 * to point to the correct plan IDs based on UUIDs
 */
export async function fixReferenceIssues(
  issues: ReferenceIssue[],
  planMap: Map<number, PlanSchema & { filename: string }>
): Promise<ReferenceFixResult> {
  const updated: ReferenceFixResult['updated'] = [];
  const errors: string[] = [];

  for (const issue of issues) {
    try {
      const plan = await readPlanFile(issue.filename);
      const fixedPlan = fixReferenceMismatches(plan, issue.verificationResult);

      // Update references after fixing mismatches
      const { updatedPlan } = ensureReferences(fixedPlan, planMap);

      await writePlanFile(issue.filename, updatedPlan, { skipUpdatedAt: true });
      updated.push({ planId: issue.planId, filename: issue.filename });
    } catch (error) {
      errors.push(
        `Failed to fix references for plan ${issue.planId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { updated, errors };
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

/**
 * Ensures all plans have complete reference entries
 */
export async function ensureAllReferences(
  planMap: Map<number, PlanSchema & { filename: string }>
): Promise<{ updated: number; errors: string[] }> {
  let updated = 0;
  const errors: string[] = [];

  for (const [_planId, plan] of planMap.entries()) {
    try {
      const { updatedPlan, plansWithGeneratedUuids } = ensureReferences(plan, planMap);

      // Only write if something changed
      const hasNewReferences =
        JSON.stringify(updatedPlan.references) !== JSON.stringify(plan.references);

      if (hasNewReferences || plansWithGeneratedUuids.length > 0) {
        await writePlanFile(plan.filename, updatedPlan, { skipUpdatedAt: true });
        updated++;

        // Write plans that had UUIDs generated
        for (const { id: genId } of plansWithGeneratedUuids) {
          const genPlan = planMap.get(genId);
          if (genPlan) {
            await writePlanFile(genPlan.filename, genPlan, { skipUpdatedAt: true });
          }
        }
      }
    } catch (error) {
      errors.push(
        `Failed to ensure references for ${plan.filename}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { updated, errors };
}

/**
 * Ensures all plans have UUIDs and complete reference entries.
 * This is a silent operation that runs as part of other commands like agent.
 *
 * @param tasksDir The directory containing plan files
 * @returns Summary of what was fixed
 */
export async function ensureUuidsAndReferences(tasksDir: string): Promise<{
  uuidsGenerated: number;
  referencesMismatchesFixed: number;
  referencesUpdated: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let uuidsGenerated = 0;
  let referencesMismatchesFixed = 0;
  let referencesUpdated = 0;

  try {
    // Load all plans
    const planResults = await readAllPlans(tasksDir, false);
    let planMap = planResults.plans;
    let uuidToId = planResults.uuidToId;

    // Step 1: Fix missing UUIDs
    const uuidIssues = detectMissingUuids(planMap);
    if (uuidIssues.length > 0) {
      const uuidFixResult = await fixMissingUuids(uuidIssues);
      uuidsGenerated = uuidFixResult.generated.length;
      errors.push(...uuidFixResult.errors);

      // Reload plans to get the new UUIDs
      if (uuidFixResult.generated.length > 0) {
        const reloadedPlans = await readAllPlans(tasksDir, false);
        planMap = reloadedPlans.plans;
        uuidToId = reloadedPlans.uuidToId;
      }
    }

    // Step 2: Fix reference mismatches
    if (uuidToId.size > 0) {
      const referenceIssues = detectReferenceIssues(planMap, uuidToId);
      if (referenceIssues.length > 0) {
        const referenceFixResult = await fixReferenceIssues(referenceIssues, planMap);
        referencesMismatchesFixed = referenceFixResult.updated.length;
        errors.push(...referenceFixResult.errors);

        // Reload plans to get updated references
        if (referenceFixResult.updated.length > 0) {
          const reloadedPlans = await readAllPlans(tasksDir, false);
          planMap = reloadedPlans.plans;
        }
      }

      // Step 3: Ensure all references are complete
      const ensureResult = await ensureAllReferences(planMap);
      referencesUpdated = ensureResult.updated;
      errors.push(...ensureResult.errors);
    }
  } catch (error) {
    errors.push(
      `Failed to ensure UUIDs and references: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    uuidsGenerated,
    referencesMismatchesFixed,
    referencesUpdated,
    errors,
  };
}
