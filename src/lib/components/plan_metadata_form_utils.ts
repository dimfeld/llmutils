import type { PlanPickerOption } from '$lib/server/plan_picker_queries.js';

export interface PlanMetadataFormState {
  title: string;
  goal: string;
  note: string;
  details: string;
  priority: string;
  status: string;
  simple: boolean;
  tagsInput: string;
  parentPlan: PlanPickerOption | null;
  basePlan: PlanPickerOption | null;
  dependencies: PlanPickerOption[];
}

export interface PlanMetadataFormPayload {
  title: string;
  goal: string;
  note: string;
  details: string;
  priority: string;
  status: string;
  simple: boolean;
  tags: string[];
  parentUuid: string | null;
  basePlanUuid: string | null;
  dependencyUuids: string[];
}

export function parsePlanMetadataTags(input: string): string[] {
  return input
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);
}

export function normalizePlanMetadataFormPayload(
  state: PlanMetadataFormState
): PlanMetadataFormPayload {
  return {
    title: state.title.trim(),
    goal: state.goal.trim(),
    note: state.note.trim(),
    details: state.details.trim(),
    priority: state.priority,
    status: state.status,
    simple: state.simple,
    tags: parsePlanMetadataTags(state.tagsInput),
    parentUuid: state.parentPlan?.uuid ?? null,
    basePlanUuid: state.basePlan?.uuid ?? null,
    dependencyUuids: state.dependencies.map((dependency) => dependency.uuid),
  };
}

export function extractPlanMetadataErrorMessage(err: unknown): string {
  const body =
    err && typeof err === 'object' && 'body' in err ? (err as { body: unknown }).body : err;
  if (body && typeof body === 'object') {
    const b = body as { message?: unknown };
    if (typeof b.message === 'string') return b.message;
  }
  if (typeof body === 'string') return body;
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
