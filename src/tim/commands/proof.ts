import { randomUUID } from 'node:crypto';

import { getLoggerAdapter } from '../../logging/adapter.js';
import { ConsoleAdapter } from '../../logging/console.js';
import { error, log } from '../../logging.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import { getAssignmentEntry } from '../db/assignment.js';
import { buildTimEnvironmentTemplateContext } from '../environment.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { LifecycleManager } from '../lifecycle.js';
import { resolveProjectContext } from '../plan_materialize.js';
import { parsePlanIdFromCliArg, resolvePlanByUuid } from '../plans.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { ProofNotConfiguredError, runProofGeneration } from '../proof/runner.js';
import { getWorkspaceInfoByPath } from '../workspace/workspace_info.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';

interface RootCommandLike {
  parent?: RootCommandLike;
  opts?: () => {
    config?: string;
  };
}

interface ProofCliOptions {
  executor?: string;
  model?: string;
  autoWorkspace?: boolean;
  terminalInput?: boolean;
}

function getRootOptions(command: RootCommandLike | undefined): { config?: string } {
  let current = command;
  while (current?.parent) {
    current = current.parent;
  }

  return current?.opts?.() ?? {};
}

export async function handleProofCommand(
  planIdArg: string | number | undefined,
  options: ProofCliOptions,
  rootCommand: RootCommandLike | undefined
): Promise<void> {
  if (planIdArg === undefined) {
    throw new Error('A numeric plan ID is required');
  }

  const globalOpts = getRootOptions(rootCommand);
  const config = await loadEffectiveConfig(globalOpts.config);
  const planId = typeof planIdArg === 'number' ? planIdArg : parsePlanIdFromCliArg(planIdArg);
  const repoRoot = await resolveRepoRoot(globalOpts.config, process.cwd());
  const context = await resolveProjectContext(repoRoot);
  const planUuid = context.planIdToUuid.get(planId);
  if (!planUuid) {
    throw new Error(`Plan not found: ${planId}`);
  }

  const { plan, planPath } = await resolvePlanByUuid(planUuid, repoRoot, { context });
  const assignment = getAssignmentEntry(getDatabase(), context.projectId, planUuid);
  const hasConfiguredWorkspace = (assignment?.workspacePaths.length ?? 0) > 0;

  let workspacePath = repoRoot;
  let workspacePlanPath = planPath ?? undefined;
  const workspaceMode = options.autoWorkspace === true || hasConfiguredWorkspace;

  await runWithHeadlessAdapterIfEnabled({
    enabled: !isTunnelActive(),
    command: 'proof',
    interactive: options.terminalInput !== false,
    plan: {
      id: plan.id,
      uuid: plan.uuid,
      title: plan.title,
    },
    callback: async () => {
      if (workspaceMode) {
        const workspaceResult = await setupWorkspace(
          {
            autoWorkspace: true,
            planId,
            planUuid,
            nonInteractive: options.terminalInput === false,
            allowPrimaryWorkspaceWhenLocked: true,
          },
          repoRoot,
          planPath ?? undefined,
          config,
          'tim proof'
        );
        workspacePath = workspaceResult.baseDir;
        workspacePlanPath = workspaceResult.planFile || workspacePlanPath;
      }

      const logger = getLoggerAdapter() ?? new ConsoleAdapter();
      const workspaceInfo = getWorkspaceInfoByPath(workspacePath);
      const timEnvironment = {
        environment: config.environment,
        context: buildTimEnvironmentTemplateContext({
          repoPath: repoRoot,
          workspace: workspaceInfo
            ? {
                workspaceId: workspaceInfo.taskId,
                workspaceName: workspaceInfo.name,
                workspacePath: workspaceInfo.workspacePath,
              }
            : {
                workspacePath,
              },
          plan: {
            planId: plan.id,
            planUuid: plan.uuid,
            planFilePath: workspacePlanPath,
            branch: plan.branch,
          },
        }),
      };
      const lifecycleManager =
        config.lifecycle?.commands && config.lifecycle.commands.length > 0
          ? new LifecycleManager(
              config.lifecycle.commands,
              workspacePath,
              workspaceInfo?.workspaceType,
              'proof',
              undefined,
              { timEnvironment }
            )
          : undefined;

      try {
        await lifecycleManager?.startup();
        const result = await runProofGeneration({
          planUuid,
          gitRoot: workspaceMode ? workspacePath : repoRoot,
          workspacePath,
          config,
          runId: randomUUID(),
          logger,
          executor: options.executor,
          model: options.model,
          terminalInput: options.terminalInput,
        });

        log(
          `Proof generation complete: attached ${result.attachedArtifactUuids.length} artifact(s).`
        );
        if (result.skippedFiles.length > 0) {
          error(`Skipped ${result.skippedFiles.length} oversized proof artifact(s).`);
        }
      } catch (err) {
        if (err instanceof ProofNotConfiguredError) {
          throw new Error(
            'No proofGeneration config found. Add a proofGeneration block to .tim/config/tim.yml; see README for an example.',
            { cause: err }
          );
        }
        throw err;
      } finally {
        await lifecycleManager?.shutdown();
      }
    },
  });
}
