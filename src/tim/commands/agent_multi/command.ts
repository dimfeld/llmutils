import fs from 'node:fs';
import path from 'node:path';

import { getLogDir } from '../../../common/config_paths.js';
import { buildWorkspaceCommandEnv } from '../../../common/env.js';
import { getGitRoot } from '../../../common/git.js';
import { isTunnelActive } from '../../../logging/tunnel_client.js';
import { getDatabase } from '../../db/database.js';
import {
  getPlanByPlanId,
  getPlanByUuid,
  getPlanDependenciesByProject,
  getPlansByProject,
  getPlanTasksByProject,
  type PlanDependencyRow,
  type PlanRow,
  type PlanTaskRow,
} from '../../db/plan.js';
import { resolveProjectContext } from '../../plan_materialize.js';
import { runWithHeadlessAdapterIfEnabled, type HeadlessPlanSummary } from '../../headless.js';
import {
  MultiAgentRunner,
  type AgentMultiPlan,
  type SpawnAgentFn,
  type SpawnAgentResult,
} from './orchestrator.js';

export interface AgentMultiCommandOptions {
  epic?: number;
  maxParallel: number;
  autoWorkspace?: boolean;
  terminalInput?: boolean;
  nonInteractive?: boolean;
}

export interface AgentMultiGlobalOptions {
  config?: string;
}

type TaskCounts = {
  taskCount: number;
  doneTaskCount: number;
};

type LogFileInfo = {
  fd: number;
  path: string;
};

function buildTaskCounts(tasks: PlanTaskRow[]): Map<string, TaskCounts> {
  const counts = new Map<string, TaskCounts>();
  for (const task of tasks) {
    const existing = counts.get(task.plan_uuid) ?? { taskCount: 0, doneTaskCount: 0 };
    existing.taskCount += 1;
    if (task.done === 1) {
      existing.doneTaskCount += 1;
    }
    counts.set(task.plan_uuid, existing);
  }
  return counts;
}

function buildDependencies(dependencies: PlanDependencyRow[]): Map<string, string[]> {
  const byPlanUuid = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const planDependencies = byPlanUuid.get(dependency.plan_uuid) ?? [];
    planDependencies.push(dependency.depends_on_uuid);
    byPlanUuid.set(dependency.plan_uuid, planDependencies);
  }
  return byPlanUuid;
}

function toAgentMultiPlan(
  row: PlanRow,
  taskCounts: Map<string, TaskCounts>,
  dependenciesByPlanUuid: Map<string, string[]>
): AgentMultiPlan {
  const counts = taskCounts.get(row.uuid) ?? { taskCount: 0, doneTaskCount: 0 };
  return {
    uuid: row.uuid,
    planId: row.plan_id,
    title: row.title,
    status: row.status,
    taskCount: counts.taskCount,
    doneTaskCount: counts.doneTaskCount,
    dependencies: dependenciesByPlanUuid.get(row.uuid) ?? [],
    basePlanUuid: row.base_plan_uuid ?? undefined,
    parentUuid: row.parent_uuid ?? undefined,
  };
}

function toHeadlessPlanSummary(row: PlanRow | null): HeadlessPlanSummary | undefined {
  if (!row) {
    return undefined;
  }

  return {
    id: row.plan_id,
    uuid: row.uuid,
    title: row.title ?? undefined,
  };
}

function createLogFile(planId: number): LogFileInfo {
  const logDir = getLogDir();
  fs.mkdirSync(logDir, { recursive: true });
  const isoTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logDir, `${planId}-${isoTimestamp}-agent-multi-child.log`);
  return { fd: fs.openSync(logPath, 'a'), path: logPath };
}

export async function createBunSpawnAgent(options: {
  autoWorkspace?: boolean;
  terminalInput?: boolean;
  cwd: string;
}): Promise<SpawnAgentFn> {
  const env = await buildWorkspaceCommandEnv(options.cwd);
  return (planId: number, cwd: string): SpawnAgentResult => {
    const args = ['agent', String(planId)];
    if (options.autoWorkspace === true) {
      args.push('--auto-workspace');
    }
    if (options.terminalInput === false) {
      args.push('--no-terminal-input');
    }

    const logFile = createLogFile(planId);
    try {
      const proc = Bun.spawn(['tim', ...args], {
        cwd,
        env,
        stdin: 'ignore',
        stdout: logFile.fd,
        stderr: logFile.fd,
        detached: true,
      });
      fs.closeSync(logFile.fd);
      return {
        exited: proc.exited,
        pid: proc.pid,
      };
    } catch (err) {
      fs.closeSync(logFile.fd);
      throw err;
    }
  };
}

export async function handleAgentMultiCommand(
  planIds: number[],
  options: AgentMultiCommandOptions,
  _globalOptions: AgentMultiGlobalOptions
): Promise<void> {
  if (planIds.length === 0) {
    throw new Error('At least one plan ID is required.');
  }

  const repoRoot = await getGitRoot();
  const context = await resolveProjectContext(repoRoot);
  const db = getDatabase();

  const allPlans = db.transaction(() => {
    const rows = getPlansByProject(db, context.projectId);
    const taskCounts = buildTaskCounts(getPlanTasksByProject(db, context.projectId));
    const dependenciesByPlanUuid = buildDependencies(
      getPlanDependenciesByProject(db, context.projectId)
    );
    return rows.map((row) => toAgentMultiPlan(row, taskCounts, dependenciesByPlanUuid));
  })();

  const allPlansById = new Map(allPlans.map((plan) => [plan.planId, plan]));
  const selectedPlans = planIds.map((planId) => {
    const plan = allPlansById.get(planId);
    if (!plan) {
      throw new Error(`Plan ${planId} not found.`);
    }
    return plan;
  });

  const epicRow = options.epic ? getPlanByPlanId(db, context.projectId, options.epic) : null;
  if (options.epic && !epicRow) {
    throw new Error(`Epic plan ${options.epic} not found.`);
  }

  await runWithHeadlessAdapterIfEnabled({
    enabled: !isTunnelActive(),
    command: 'agent-multi',
    interactive: options.nonInteractive !== true,
    plan: toHeadlessPlanSummary(epicRow),
    callback: async () => {
      const runner = new MultiAgentRunner({
        plans: selectedPlans,
        allPlans,
        epicUuid: epicRow?.uuid,
        maxParallel: options.maxParallel,
        cwd: repoRoot,
        spawnAgent: await createBunSpawnAgent({
          autoWorkspace: options.autoWorkspace,
          terminalInput: options.terminalInput,
          cwd: repoRoot,
        }),
        readPlan: async (planUuid: string) => getPlanByUuid(db, planUuid),
      });
      const result = await runner.run();
      if (!result.success) {
        process.exitCode = 1;
      }
    },
  });
}
