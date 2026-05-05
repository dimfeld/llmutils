import type { PlanDependencyRow, PlanTagRow } from '../db/plan.js';
import type {
  ApplyOperationToAdapter,
  ApplyOperationToPlan,
  ApplyOperationToTask,
} from './operation_fold.js';

export interface PlanStateAdapterState {
  plan: ApplyOperationToPlan | null;
  tasks: ApplyOperationToTask[];
  dependencies: PlanDependencyRow[];
  tags: PlanTagRow[];
}

export abstract class BasePlanStateAdapter implements ApplyOperationToAdapter {
  protected plans = new Map<string, ApplyOperationToPlan | null>();
  protected tasks = new Map<string, ApplyOperationToTask[]>();
  protected dependencies = new Map<string, PlanDependencyRow[]>();
  protected tags = new Map<string, PlanTagRow[]>();

  constructor(readonly project: { id: number; uuid: string }) {}

  getPlan(planUuid: string): ApplyOperationToPlan | null {
    this.ensureLoaded(planUuid);
    const plan = this.plans.get(planUuid) ?? null;
    return plan ? { ...plan } : null;
  }

  getPlanForCreateDuplicateCheck(planUuid: string): ApplyOperationToPlan | null {
    return this.getPlan(planUuid);
  }

  getTaskByUuid(taskUuid: string): ApplyOperationToTask | null {
    for (const tasks of this.tasks.values()) {
      const task = tasks.find((item) => item.uuid === taskUuid);
      if (task) {
        return { ...task };
      }
    }
    return this.readTaskByUuid(taskUuid);
  }

  setPlan(plan: ApplyOperationToPlan): void {
    this.plans.set(plan.uuid, { ...plan });
    this.ensureEmptyCollections(plan.uuid);
    this.onPlanStateTouched(plan.uuid);
  }

  deletePlan(planUuid: string): void {
    this.plans.set(planUuid, null);
    this.tasks.set(planUuid, []);
    this.dependencies.set(planUuid, []);
    this.tags.set(planUuid, []);
    this.onPlanStateTouched(planUuid);
  }

  getTasks(planUuid: string): ApplyOperationToTask[] {
    this.ensureLoaded(planUuid);
    return (this.tasks.get(planUuid) ?? []).map((task) => ({ ...task }));
  }

  setTasks(planUuid: string, tasks: ApplyOperationToTask[]): void {
    this.tasks.set(
      planUuid,
      tasks.map((task) => ({ ...task }))
    );
    this.onPlanStateTouched(planUuid);
  }

  getDependencies(planUuid: string): PlanDependencyRow[] {
    this.ensureLoaded(planUuid);
    return (this.dependencies.get(planUuid) ?? []).map((dependency) => ({ ...dependency }));
  }

  setDependencies(planUuid: string, dependencies: PlanDependencyRow[]): void {
    this.dependencies.set(
      planUuid,
      dependencies.map((dependency) => ({ ...dependency }))
    );
    this.onPlanStateTouched(planUuid);
  }

  getTags(planUuid: string): PlanTagRow[] {
    this.ensureLoaded(planUuid);
    return (this.tags.get(planUuid) ?? []).map((tag) => ({ ...tag }));
  }

  setTags(planUuid: string, tags: PlanTagRow[]): void {
    this.tags.set(
      planUuid,
      tags.map((tag) => ({ ...tag }))
    );
    this.onPlanStateTouched(planUuid);
  }

  abstract resolveLocalPlanId(planUuid: string | null | undefined): number | null;
  abstract resolvePlanCreateNumericPlanId(
    requestedPlanId: number | undefined,
    preserveRequestedPlanIds?: boolean
  ): number;

  protected ensureLoaded(planUuid: string): void {
    if (!this.plans.has(planUuid)) {
      this.loadPlanState(planUuid);
    }
  }

  protected setLoadedPlanState(planUuid: string, state: PlanStateAdapterState): void {
    this.plans.set(planUuid, state.plan ? { ...state.plan } : null);
    this.tasks.set(
      planUuid,
      state.tasks.map((task) => ({ ...task }))
    );
    this.dependencies.set(
      planUuid,
      state.dependencies.map((dependency) => ({ ...dependency }))
    );
    this.tags.set(
      planUuid,
      state.tags.map((tag) => ({ ...tag }))
    );
  }

  protected ensureEmptyCollections(planUuid: string): void {
    if (!this.tasks.has(planUuid)) {
      this.tasks.set(planUuid, []);
    }
    if (!this.dependencies.has(planUuid)) {
      this.dependencies.set(planUuid, []);
    }
    if (!this.tags.has(planUuid)) {
      this.tags.set(planUuid, []);
    }
  }

  protected onPlanStateTouched(_planUuid: string): void {}

  protected abstract loadPlanState(planUuid: string): void;
  protected abstract readTaskByUuid(taskUuid: string): ApplyOperationToTask | null;
}
