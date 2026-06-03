import { error, redirect } from '@sveltejs/kit';

import type { PlanMetadataFormInitialValue } from '$lib/components/PlanMetadataForm.svelte';
import { getServerContext } from '$lib/server/init.js';
import type { EnrichedPlanDependency } from '$lib/server/db_queries.js';
import { getPlanDetailRouteData } from '$lib/server/plans_browser.js';
import type { PlanPickerOption } from '$lib/server/plan_picker_queries.js';
import type { PageServerLoad } from './$types';

function dependencyToPickerOption(
  dependency: EnrichedPlanDependency,
  fallbackProjectId: number
): PlanPickerOption {
  return {
    uuid: dependency.uuid,
    projectId: dependency.projectId ?? fallbackProjectId,
    planId: dependency.planId,
    title: dependency.title,
    status: dependency.status,
    priority: null,
    parentUuid: null,
    basePlanUuid: null,
  };
}

export const load: PageServerLoad = async ({ params }) => {
  const { db } = await getServerContext();
  const result = await getPlanDetailRouteData(db, params.planId, params.projectId, 'plans');

  if (!result) {
    error(404, 'Plan not found');
  }

  if (result.redirectTo) {
    redirect(302, `${result.redirectTo}/edit`);
  }

  const { planDetail } = result;
  const parent = planDetail.parent
    ? dependencyToPickerOption(planDetail.parent, planDetail.projectId)
    : null;
  const basePlan = planDetail.basePlan
    ? dependencyToPickerOption(planDetail.basePlan, planDetail.projectId)
    : null;
  const dependencies = planDetail.dependencies.map((dependency) =>
    dependencyToPickerOption(dependency, planDetail.projectId)
  );
  const initialValue: PlanMetadataFormInitialValue = {
    title: planDetail.title ?? '',
    goal: planDetail.goal ?? '',
    note: planDetail.note ?? '',
    details: planDetail.details ?? '',
    priority: planDetail.priority ?? 'medium',
    status: planDetail.status,
    simple: planDetail.simple,
    tags: planDetail.tags,
    parent,
    basePlan,
    dependencies,
  };

  return {
    planUuid: planDetail.uuid,
    planId: planDetail.planId,
    title: planDetail.title,
    routeProjectId: params.projectId,
    actualProjectId: planDetail.projectId,
    cancelHref: `/projects/${params.projectId}/plans/${planDetail.uuid}`,
    initialValue,
  };
};
