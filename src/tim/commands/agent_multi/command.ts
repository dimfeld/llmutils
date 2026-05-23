import fs from 'node:fs';

import { buildWorkspaceCommandEnv } from '../../../common/env.js';
import { getGitRoot } from '../../../common/git.js';
import { createLogFile } from '../../../common/log_files.js';
import { isTunnelActive } from '../../../logging/tunnel_client.js';
import { getDatabase } from '../../db/database.js';
import { getPlanByPlanId, getPlanByUuid, type PlanRow } from '../../db/plan.js';
import { resolveProjectContext } from '../../plan_materialize.js';
import {
  runWithHeadlessAdapterIfEnabled,
  updateHeadlessSessionInfo,
  type HeadlessPlanSummary,
} from '../../headless.js';
import {
  MultiAgentRunner,
  SelectionValidationError,
  validateSelection,
  type SpawnAgentFn,
  type SpawnAgentResult,
} from './orchestrator.js';
import { getAgentMultiPlansForProject } from './plan_loader.js';

export interface AgentMultiCommandOptions {
  epic?: number;
  maxParallel: number;
  terminalInput?: boolean;
  nonInteractive?: boolean;
}

export interface AgentMultiGlobalOptions {
  config?: string;
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

export async function createBunSpawnAgent(options: { cwd: string }): Promise<SpawnAgentFn> {
  const env = await buildWorkspaceCommandEnv(options.cwd);
  // Parallel agent runs cannot share a primary workspace or interactive stdin.
  return (planId: number, cwd: string): SpawnAgentResult => {
    const args = buildChildAgentArgs(planId);

    const logFile = createLogFile('agent-multi-child', planId);
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

export function buildChildAgentArgs(
  planId: number,
  options: { terminalInput?: boolean } = {}
): string[] {
  const args = ['agent', String(planId)];
  args.push('--auto-workspace');
  if (options.terminalInput !== true) {
    args.push('--no-terminal-input');
  }
  return args;
}

function getHeadlessPlanRow(options: {
  explicitEpicRow: PlanRow | null;
  inferredParentUuid?: string;
  db: ReturnType<typeof getDatabase>;
}): PlanRow | null {
  if (options.explicitEpicRow) {
    return options.explicitEpicRow;
  }
  // Root-level sibling runs have no shared parent plan to attribute the
  // orchestrator session to; keep the existing unattributed-session behavior.
  if (!options.inferredParentUuid) {
    return null;
  }
  return getPlanByUuid(options.db, options.inferredParentUuid);
}

export async function handleAgentMultiCommand(
  planIds: number[],
  options: AgentMultiCommandOptions,
  _globalOptions: AgentMultiGlobalOptions
): Promise<void> {
  await runWithHeadlessAdapterIfEnabled({
    enabled: !isTunnelActive(),
    command: 'agent-multi',
    interactive: false,
    callback: async () => {
      await runAgentMultiCommand(planIds, options);
    },
  });
}

async function runAgentMultiCommand(
  planIds: number[],
  options: AgentMultiCommandOptions
): Promise<void> {
  if (planIds.length === 0) {
    throw new Error('At least one plan ID is required.');
  }
  const seenPlanIds = new Set<number>();
  for (const planId of planIds) {
    if (seenPlanIds.has(planId)) {
      throw new Error(`Duplicate plan id in input: ${planId}`);
    }
    seenPlanIds.add(planId);
  }

  const repoRoot = await getGitRoot();
  const context = await resolveProjectContext(repoRoot);
  const db = getDatabase();

  const allPlans = getAgentMultiPlansForProject(db, context.projectId);

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

  const validation = validateSelection(selectedPlans, {
    allPlans,
    epicUuid: epicRow?.uuid,
  });
  if (!validation.ok) {
    throw new SelectionValidationError(validation);
  }
  const headlessPlanRow = getHeadlessPlanRow({
    explicitEpicRow: epicRow,
    inferredParentUuid: validation.sharedParentUuid,
    db,
  });
  const headlessPlan = toHeadlessPlanSummary(headlessPlanRow);
  if (headlessPlan) {
    updateHeadlessSessionInfo({
      planId: headlessPlan.id,
      planUuid: headlessPlan.uuid,
      planTitle: headlessPlan.title,
    });
  }

  const runner = new MultiAgentRunner({
    plans: selectedPlans,
    allPlans,
    epicUuid: epicRow?.uuid,
    maxParallel: options.maxParallel,
    cwd: repoRoot,
    spawnAgent: await createBunSpawnAgent({
      cwd: repoRoot,
    }),
    readPlan: async (planUuid: string) => getPlanByUuid(db, planUuid),
  });
  const result = await runner.run();
  if (!result.success) {
    process.exitCode = 1;
  }
}
