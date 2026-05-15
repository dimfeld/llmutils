import fs from 'node:fs';

import { buildWorkspaceCommandEnv } from '../../../common/env.js';
import { getGitRoot } from '../../../common/git.js';
import { isTunnelActive } from '../../../logging/tunnel_client.js';
import { createLogFile } from '../../../lib/server/plan_actions.js';
import { getDatabase } from '../../db/database.js';
import { getPlanByPlanId, getPlanByUuid, type PlanRow } from '../../db/plan.js';
import { resolveProjectContext } from '../../plan_materialize.js';
import { runWithHeadlessAdapterIfEnabled, type HeadlessPlanSummary } from '../../headless.js';
import { MultiAgentRunner, type SpawnAgentFn, type SpawnAgentResult } from './orchestrator.js';
import { getAgentMultiPlansForProject } from './plan_loader.js';

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
