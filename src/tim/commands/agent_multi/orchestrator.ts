import { error, log, sendStructured } from '../../../logging.js';
import type { PlanStatus } from '../../plans/plan_state_utils.js';
import { isWorkComplete } from '../../plans/plan_state_utils.js';

export type AgentMultiPlan = {
  uuid: string;
  planId: number;
  title: string | null;
  status: PlanStatus;
  taskCount: number;
  doneTaskCount: number;
  dependencies: string[];
  basePlanUuid?: string;
  parentUuid?: string;
};

export type SelectionValidationIssue =
  | {
      type: 'ineligible_status';
      planUuid: string;
      planId: number;
      status: PlanStatus;
    }
  | {
      type: 'no_remaining_tasks';
      planUuid: string;
      planId: number;
    }
  | {
      type: 'unfinished_external_dependency';
      planUuid: string;
      planId: number;
      dependencyUuid: string;
      dependencyPlanId?: number;
    }
  | {
      type: 'missing_dependency';
      planUuid: string;
      planId: number;
      dependencyUuid: string;
    }
  | {
      type: 'epic_mismatch';
      planUuid: string;
      planId: number;
      expectedEpicUuid: string;
      actualEpicUuid: string | undefined;
    }
  | {
      type: 'cycle';
      cycle: string[];
    };

export type SelectionValidationResult =
  | {
      ok: true;
      plans: AgentMultiPlan[];
      depsByPlanUuid: Map<string, Set<string>>;
      depsInInputByPlanUuid: Map<string, Set<string>>;
      readyPlanUuids: string[];
      waitingPlanUuids: string[];
    }
  | {
      ok: false;
      issues: SelectionValidationIssue[];
      message: string;
    };

export type ValidateSelectionOptions = {
  epicUuid?: string;
  /**
   * Full project plan list used to classify dependencies outside the selected input.
   * Callers should pass this when available so unfinished external dependencies can
   * be reported distinctly from dependencies that are missing from the DB.
   */
  allPlans?: Iterable<AgentMultiPlan>;
};

export type SpawnAgentResult = {
  exited: Promise<number>;
  pid?: number;
};

export type SpawnAgentFn = (planId: number, cwd: string) => SpawnAgentResult;

export type ReadPlanFn = (planUuid: string) => Promise<Pick<AgentMultiPlan, 'status'> | null>;

export type PlanRunStatus = 'pending' | 'running' | 'finished' | 'failed';

export type PlanRunState = {
  plan: AgentMultiPlan;
  status: PlanRunStatus;
  deps: Set<string>;
  depsInInput: Set<string>;
  process?: SpawnAgentResult;
  pid?: number;
  exitCode?: number;
  failureReason?: string;
};

export type PlanRunStateSnapshot = Readonly<{
  status: PlanRunStatus;
  exitCode?: number;
  failureReason?: string;
  pid?: number;
}>;

export type MultiAgentRunResult = {
  success: boolean;
  states: Map<string, PlanRunStateSnapshot>;
};

export type MultiAgentLogger = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  sendStructured: (message: Parameters<typeof sendStructured>[0]) => void;
};

export type MultiAgentRunnerOptions = {
  plans: AgentMultiPlan[];
  allPlans?: Iterable<AgentMultiPlan>;
  epicUuid?: string;
  maxParallel?: number;
  cwd: string;
  spawnAgent: SpawnAgentFn;
  readPlan: ReadPlanFn;
  logger?: MultiAgentLogger;
};

type RunningExit = {
  planUuid: string;
  exitCode: number;
};

const DEFAULT_MAX_PARALLEL = 3;

const defaultLogger: MultiAgentLogger = {
  log,
  error,
  sendStructured,
};

export class SelectionValidationError extends Error {
  readonly issues: SelectionValidationIssue[];

  constructor(result: Extract<SelectionValidationResult, { ok: false }>) {
    super(result.message);
    this.name = 'SelectionValidationError';
    this.issues = result.issues;
  }
}

export function validateSelection(
  plans: AgentMultiPlan[],
  options: ValidateSelectionOptions = {}
): SelectionValidationResult {
  const issues: SelectionValidationIssue[] = [];
  const selectedByUuid = new Map<string, AgentMultiPlan>();
  for (const plan of plans) {
    selectedByUuid.set(plan.uuid, plan);
  }

  const allPlansByUuid = new Map<string, AgentMultiPlan>();
  for (const plan of options.allPlans ?? plans) {
    allPlansByUuid.set(plan.uuid, plan);
  }
  for (const plan of plans) {
    allPlansByUuid.set(plan.uuid, plan);
  }

  const depsByPlanUuid = new Map<string, Set<string>>();
  const depsInInputByPlanUuid = new Map<string, Set<string>>();

  for (const plan of plans) {
    if (isWorkComplete(plan) || plan.status === 'deferred') {
      issues.push({
        type: 'ineligible_status',
        planUuid: plan.uuid,
        planId: plan.planId,
        status: plan.status,
      });
    }
    if (plan.taskCount <= plan.doneTaskCount) {
      issues.push({ type: 'no_remaining_tasks', planUuid: plan.uuid, planId: plan.planId });
    }
    if (options.epicUuid && !planBelongsToEpic(plan, options.epicUuid)) {
      issues.push({
        type: 'epic_mismatch',
        planUuid: plan.uuid,
        planId: plan.planId,
        expectedEpicUuid: options.epicUuid,
        actualEpicUuid: plan.parentUuid,
      });
    }

    const deps = getPlanDependencyUuids(plan);
    depsByPlanUuid.set(plan.uuid, deps);

    const depsInInput = new Set<string>();
    for (const dependencyUuid of deps) {
      if (selectedByUuid.has(dependencyUuid)) {
        depsInInput.add(dependencyUuid);
        continue;
      }

      const dependencyPlan = allPlansByUuid.get(dependencyUuid);
      if (!dependencyPlan) {
        issues.push({
          type: 'missing_dependency',
          planUuid: plan.uuid,
          planId: plan.planId,
          dependencyUuid,
        });
      } else if (!isWorkComplete(dependencyPlan)) {
        issues.push({
          type: 'unfinished_external_dependency',
          planUuid: plan.uuid,
          planId: plan.planId,
          dependencyUuid,
          dependencyPlanId: dependencyPlan.planId,
        });
      }
    }
    depsInInputByPlanUuid.set(plan.uuid, depsInInput);
  }

  const cycle = findInputCycle(plans, depsInInputByPlanUuid);
  if (cycle) {
    issues.push({ type: 'cycle', cycle });
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
      message: formatValidationIssues(issues),
    };
  }

  const readyPlanUuids: string[] = [];
  const waitingPlanUuids: string[] = [];
  for (const plan of plans) {
    const depsInInput = depsInInputByPlanUuid.get(plan.uuid) ?? new Set<string>();
    if (depsInInput.size === 0) {
      readyPlanUuids.push(plan.uuid);
    } else {
      waitingPlanUuids.push(plan.uuid);
    }
  }

  return {
    ok: true,
    plans,
    depsByPlanUuid,
    depsInInputByPlanUuid,
    readyPlanUuids,
    waitingPlanUuids,
  };
}

export class MultiAgentRunner {
  private readonly states: Map<string, PlanRunState>;
  private readonly maxParallel: number;
  private readonly cwd: string;
  private readonly spawnAgent: SpawnAgentFn;
  private readonly readPlan: ReadPlanFn;
  private readonly logger: MultiAgentLogger;

  constructor(options: MultiAgentRunnerOptions) {
    const validation = validateSelection(options.plans, {
      allPlans: options.allPlans,
      epicUuid: options.epicUuid,
    });
    if (!validation.ok) {
      throw new SelectionValidationError(validation);
    }

    this.states = new Map(
      validation.plans.map((plan) => [
        plan.uuid,
        {
          plan,
          status: 'pending' as const,
          deps: validation.depsByPlanUuid.get(plan.uuid) ?? new Set<string>(),
          depsInInput: validation.depsInInputByPlanUuid.get(plan.uuid) ?? new Set<string>(),
        },
      ])
    );
    this.maxParallel = Math.max(1, Math.floor(options.maxParallel ?? DEFAULT_MAX_PARALLEL));
    this.cwd = options.cwd;
    this.spawnAgent = options.spawnAgent;
    this.readPlan = options.readPlan;
    this.logger = options.logger ?? defaultLogger;
  }

  async run(): Promise<MultiAgentRunResult> {
    this.logInitialSummary();
    this.tick();

    while (this.hasStatus('pending') || this.hasStatus('running')) {
      if (!this.hasStatus('running')) {
        this.markBlockedPendingPlansFailed();
        break;
      }

      const exit = await this.waitForNextExit();
      await this.handleExit(exit.planUuid, exit.exitCode);
      this.tick();
    }

    this.logFinalSummary();
    return {
      success: Array.from(this.states.values()).every((state) => state.status === 'finished'),
      states: this.snapshot(),
    };
  }

  snapshot(): Map<string, PlanRunStateSnapshot> {
    return new Map(
      Array.from(this.states.entries()).map(([planUuid, state]) => [
        planUuid,
        {
          status: state.status,
          exitCode: state.exitCode,
          failureReason: state.failureReason,
          pid: state.pid,
        },
      ])
    );
  }

  private tick(): void {
    while (this.runningCount() < this.maxParallel) {
      const next = this.nextRunnablePendingState();
      if (!next) {
        return;
      }

      let child: SpawnAgentResult;
      try {
        child = this.spawnAgent(next.plan.planId, this.cwd);
      } catch (err) {
        next.status = 'failed';
        next.failureReason = `spawn failed: ${err instanceof Error ? err.message : String(err)}`;
        this.logger.error(`agent-multi: plan ${formatPlan(next.plan)} ${next.failureReason}`);
        this.sendWorkflowProgress(`Plan ${formatPlan(next.plan)} failed to spawn`, 'spawn');
        this.markDownstreamFailed(next.plan.uuid);
        continue;
      }
      next.status = 'running';
      next.process = child;
      next.pid = child.pid;
      this.logger.log(
        `agent-multi: spawned plan ${formatPlan(next.plan)}${child.pid ? ` pid=${child.pid}` : ''}`
      );
      this.sendWorkflowProgress(`Spawned plan ${formatPlan(next.plan)}`, 'spawn');
    }
  }

  private async waitForNextExit(): Promise<RunningExit> {
    const running = Array.from(this.states.values()).filter(
      (state) => state.status === 'running' && state.process
    );
    return Promise.race(
      running.map(
        async (state): Promise<RunningExit> => ({
          planUuid: state.plan.uuid,
          exitCode: await state.process!.exited,
        })
      )
    );
  }

  private async handleExit(planUuid: string, exitCode: number): Promise<void> {
    const state = this.states.get(planUuid);
    if (!state || state.status !== 'running') {
      return;
    }

    state.exitCode = exitCode;
    const freshPlan = await this.readPlan(planUuid);
    const finished = exitCode === 0 && freshPlan != null && isWorkComplete(freshPlan);
    if (finished) {
      state.status = 'finished';
      this.logger.log(
        `agent-multi: plan ${formatPlan(state.plan)} exited ${exitCode}; status=${freshPlan.status}; finished`
      );
      this.sendWorkflowProgress(`Plan ${formatPlan(state.plan)} finished`, 'exit');
      return;
    }

    state.status = 'failed';
    if (exitCode !== 0) {
      state.failureReason = freshPlan
        ? `agent exited with code ${exitCode}; plan status is ${freshPlan.status}`
        : `agent exited with code ${exitCode}; plan was not found after agent exit`;
    } else {
      state.failureReason = freshPlan
        ? `plan status is ${freshPlan.status}`
        : 'plan was not found after agent exit';
    }
    this.logger.error(
      `agent-multi: plan ${formatPlan(state.plan)} exited ${exitCode}; ${state.failureReason}`
    );
    this.sendWorkflowProgress(`Plan ${formatPlan(state.plan)} failed`, 'exit');
    this.markDownstreamFailed(planUuid);
  }

  private markDownstreamFailed(failedPlanUuid: string): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const state of this.states.values()) {
        if (state.status !== 'pending') {
          continue;
        }
        if (!state.depsInInput.has(failedPlanUuid)) {
          const failedDependency = Array.from(state.depsInInput).some(
            (dependencyUuid) => this.states.get(dependencyUuid)?.status === 'failed'
          );
          if (!failedDependency) {
            continue;
          }
        }
        state.status = 'failed';
        state.failureReason = `skipped because dependency ${failedPlanUuid} failed`;
        this.logger.error(
          `agent-multi: skipped plan ${formatPlan(state.plan)}; ${state.failureReason}`
        );
        this.sendWorkflowProgress(`Skipped plan ${formatPlan(state.plan)}`, 'skip');
        changed = true;
      }
    }
  }

  private markBlockedPendingPlansFailed(): void {
    // Defensive guard: normal failure propagation should skip blocked downstream plans.
    for (const state of this.states.values()) {
      if (state.status !== 'pending') {
        continue;
      }
      state.status = 'failed';
      state.failureReason = 'no runnable dependencies remain';
      this.logger.error(
        `agent-multi: skipped plan ${formatPlan(state.plan)}; ${state.failureReason}`
      );
    }
  }

  private nextRunnablePendingState(): PlanRunState | null {
    for (const state of this.states.values()) {
      if (state.status !== 'pending') {
        continue;
      }
      if (
        Array.from(state.depsInInput).every(
          (dependencyUuid) => this.states.get(dependencyUuid)?.status === 'finished'
        )
      ) {
        return state;
      }
    }
    return null;
  }

  private hasStatus(status: PlanRunStatus): boolean {
    return Array.from(this.states.values()).some((state) => state.status === status);
  }

  private runningCount(): number {
    return Array.from(this.states.values()).filter((state) => state.status === 'running').length;
  }

  private logInitialSummary(): void {
    const ready = Array.from(this.states.values()).filter((state) => state.depsInInput.size === 0);
    const waiting = Array.from(this.states.values()).filter((state) => state.depsInInput.size > 0);
    const message = `agent-multi: ${this.states.size} plan(s), maxParallel=${this.maxParallel}, ready=[${ready
      .map((state) => state.plan.planId)
      .join(', ')}], waiting=[${waiting.map((state) => state.plan.planId).join(', ')}]`;
    this.logger.log(message);
    this.sendWorkflowProgress(message, 'summary');
  }

  private logFinalSummary(): void {
    const counts = new Map<PlanRunStatus, number>();
    for (const state of this.states.values()) {
      counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
    }
    const message = `agent-multi: finished=${counts.get('finished') ?? 0}, failed=${
      counts.get('failed') ?? 0
    }, running=${counts.get('running') ?? 0}, pending=${counts.get('pending') ?? 0}`;
    this.logger.log(message);
    this.sendWorkflowProgress(message, 'summary');
  }

  private sendWorkflowProgress(message: string, phase: string): void {
    this.logger.sendStructured({
      type: 'workflow_progress',
      timestamp: new Date().toISOString(),
      message,
      phase: `agent-multi:${phase}`,
    });
  }
}

function planBelongsToEpic(plan: AgentMultiPlan, epicUuid: string): boolean {
  return plan.parentUuid === epicUuid;
}

function getPlanDependencyUuids(plan: AgentMultiPlan): Set<string> {
  const deps = new Set(plan.dependencies);
  if (plan.basePlanUuid) {
    deps.add(plan.basePlanUuid);
  }
  return deps;
}

function findInputCycle(
  plans: AgentMultiPlan[],
  depsInInputByPlanUuid: Map<string, Set<string>>
): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(planUuid: string): string[] | null {
    if (visiting.has(planUuid)) {
      return stack.slice(stack.indexOf(planUuid)).concat(planUuid);
    }
    if (visited.has(planUuid)) {
      return null;
    }

    visiting.add(planUuid);
    stack.push(planUuid);
    for (const dependencyUuid of depsInInputByPlanUuid.get(planUuid) ?? []) {
      const cycle = visit(dependencyUuid);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(planUuid);
    visited.add(planUuid);
    return null;
  }

  for (const plan of plans) {
    const cycle = visit(plan.uuid);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

function formatValidationIssues(issues: SelectionValidationIssue[]): string {
  return issues.map(formatValidationIssue).join('\n');
}

function formatValidationIssue(issue: SelectionValidationIssue): string {
  switch (issue.type) {
    case 'ineligible_status':
      return `Plan ${issue.planId} is not eligible for agent-multi because status is ${issue.status}`;
    case 'no_remaining_tasks':
      return `Plan ${issue.planId} is not eligible for agent-multi because it has no remaining tasks`;
    case 'unfinished_external_dependency':
      return `Plan ${issue.planId} depends on unfinished external plan ${
        issue.dependencyPlanId ?? issue.dependencyUuid
      }`;
    case 'missing_dependency':
      return `Plan ${issue.planId} depends on missing plan ${issue.dependencyUuid}`;
    case 'epic_mismatch':
      return `Plan ${issue.planId} does not belong to epic ${issue.expectedEpicUuid}`;
    case 'cycle':
      return `Selected plans contain a dependency cycle: ${issue.cycle.join(' -> ')}`;
  }
}

function formatPlan(plan: AgentMultiPlan): string {
  return `#${plan.planId}${plan.title ? ` ${plan.title}` : ''}`;
}
