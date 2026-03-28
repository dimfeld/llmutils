import * as path from 'node:path';
import { commitAll } from '../../common/process.js';
import { warn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { syncPlanToDb } from '../db/plan_sync.js';
import { buildDescriptionFromPlan, getCombinedTitleFromSummary } from '../display_utils.js';
import { resolvePlanFromDbOrSyncFile } from '../ensure_plan_in_db.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { buildExecutorAndLog, DEFAULT_EXECUTOR } from '../executors/index.js';
import { ClaudeCodeExecutorName, CodexCliExecutorName } from '../executors/schemas.js';
import { isCodexAppServerEnabled } from '../executors/codex_cli/app_server_mode.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { readPlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { generateBranchNameFromPlan } from './branch.js';
import { resolveOptionalPromptInput, type PromptResolverDeps } from './prompt_input.js';
import {
  patchWorkspaceInfo,
  getWorkspaceInfoByPath,
  touchWorkspaceInfo,
} from '../workspace/workspace_info.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import {
  prepareWorkspaceRoundTrip,
  runPostExecutionWorkspaceSync,
  runPreExecutionWorkspaceSync,
} from '../workspace/workspace_roundtrip.js';

const CHAT_COMPATIBLE_EXECUTORS = new Set([ClaudeCodeExecutorName, CodexCliExecutorName]);
const CHAT_EXECUTOR_ALIASES = new Map<string, string>([
  ['claude', ClaudeCodeExecutorName],
  [ClaudeCodeExecutorName, ClaudeCodeExecutorName],
  ['codex', CodexCliExecutorName],
  [CodexCliExecutorName, CodexCliExecutorName],
]);

export interface ChatCommandOptions {
  executor?: string;
  model?: string;
  promptFile?: string;
  nonInteractive?: boolean;
  terminalInput?: boolean;
  headlessAdapter?: boolean;
  workspace?: string;
  autoWorkspace?: boolean;
  newWorkspace?: boolean;
  base?: string;
  workspaceSync?: boolean;
  commit?: boolean;
  plan?: string;
}

export interface ChatGlobalOptions {
  config?: string;
}

async function updateWorkspaceDescriptionFromPlan(
  baseDir: string,
  planData: PlanSchema
): Promise<void> {
  try {
    const workspaceMetadata = getWorkspaceInfoByPath(baseDir);
    if (!workspaceMetadata) {
      return;
    }

    const description = buildDescriptionFromPlan(planData);
    const planId = planData.id ? String(planData.id) : '';
    const prefixedDescription = planId ? `${planId} - ${description}` : description;
    const planTitle = getCombinedTitleFromSummary(planData);

    patchWorkspaceInfo(baseDir, {
      description: prefixedDescription,
      planId,
      planTitle: planTitle || '',
      issueUrls: planData.issue && planData.issue.length > 0 ? [...planData.issue] : [],
    });
  } catch (err) {
    warn(`Failed to update workspace description: ${err as Error}`);
  }
}

function resolveChatExecutor(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }

  return CHAT_EXECUTOR_ALIASES.get(input.trim().toLowerCase());
}

export async function resolveOptionalPromptText(
  promptText: string | undefined,
  options: { promptFile?: string; stdinIsTTY?: boolean; tunnelActive?: boolean },
  deps: PromptResolverDeps = {}
): Promise<string | undefined> {
  const tunnelActive = options.tunnelActive ?? false;
  const hasPromptFile = Boolean(options.promptFile);
  const shouldReadStdinWhenNotTTY = !tunnelActive && !hasPromptFile;

  return resolveOptionalPromptInput(
    {
      promptText,
      promptFile: options.promptFile,
      stdinIsTTY: options.stdinIsTTY,
      readStdinWhenNotTTY: shouldReadStdinWhenNotTTY,
      preferPositionalPrompt: true,
    },
    deps
  );
}

export async function handleChatCommand(
  promptText: string | undefined,
  options: ChatCommandOptions,
  globalOpts: ChatGlobalOptions
): Promise<void> {
  const config = await loadEffectiveConfig(globalOpts.config);
  const workspaceMode =
    options.workspace !== undefined ||
    options.autoWorkspace === true ||
    options.newWorkspace === true ||
    options.plan !== undefined;

  // Validate that workspace-modifier flags require workspace mode
  if (!workspaceMode) {
    if (options.base) {
      throw new Error('--base requires a workspace option (-w, --aw, --nw, or --plan)');
    }
    if (options.commit) {
      throw new Error('--commit requires a workspace option (-w, --aw, --nw, or --plan)');
    }
  }

  const requestedExecutorRaw = options.executor ?? config.defaultExecutor;
  const requestedExecutor = resolveChatExecutor(requestedExecutorRaw);
  if (requestedExecutorRaw && !requestedExecutor) {
    const allowed = [...CHAT_EXECUTOR_ALIASES.keys()].join(', ');
    if (options.executor) {
      throw new Error(
        `Executor '${requestedExecutorRaw}' is not supported by 'tim chat'. Supported executors: ${allowed}`
      );
    }
    // config.defaultExecutor is incompatible, fall back to DEFAULT_EXECUTOR
    console.warn(
      `Warning: defaultExecutor '${requestedExecutorRaw}' is not supported by 'tim chat'. Falling back to '${DEFAULT_EXECUTOR}'.`
    );
  }
  const executorName = requestedExecutor ?? DEFAULT_EXECUTOR;
  const tunnelActive = isTunnelActive();
  const prompt = await resolveOptionalPromptText(promptText, {
    promptFile: options.promptFile,
    stdinIsTTY: process.stdin.isTTY,
    tunnelActive,
  });
  const codexAppServerEnabled = isCodexAppServerEnabled();

  const noninteractive = options.nonInteractive === true;
  const canUseTerminalInput =
    !noninteractive &&
    process.stdin.isTTY === true &&
    options.terminalInput !== false &&
    config.terminalInput !== false;
  const terminalInputEnabled =
    executorName === CodexCliExecutorName && !codexAppServerEnabled ? false : canUseTerminalInput;

  if (executorName === CodexCliExecutorName && !codexAppServerEnabled && !prompt) {
    throw new Error(
      'codex-cli requires an explicit prompt. Provide a prompt via argument, --prompt-file, or stdin.'
    );
  }

  if (!prompt && !terminalInputEnabled && !tunnelActive) {
    throw new Error(
      'No input provided. Pass a prompt argument, --prompt-file, or stdin when running without terminal input.'
    );
  }

  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: process.cwd(),
    model: options.model,
    noninteractive: noninteractive ? true : undefined,
    terminalInput: terminalInputEnabled,
    closeTerminalInputOnResult: false,
    disableInactivityTimeout: true,
  };
  let currentBaseDir = sharedExecutorOptions.baseDir;
  let currentPlanFile = '';
  let currentPlanData: PlanSchema | undefined;
  let touchedWorkspacePath: string | null = null;
  let roundTripContext: Awaited<ReturnType<typeof prepareWorkspaceRoundTrip>> = null;
  let executionError: unknown;

  // Resolve repo root from config/plan arg once, for both plan resolution and workspace setup
  const configRepoRoot = await resolveRepoRootForPlanArg(
    options.plan ?? '',
    undefined,
    globalOpts.config
  );

  if (options.plan) {
    const resolvedPlan = await resolvePlanFromDbOrSyncFile(
      options.plan,
      configRepoRoot,
      configRepoRoot
    );
    currentPlanFile = resolvedPlan.planPath ?? '';
    currentPlanData = resolvedPlan.plan;
  }

  await runWithHeadlessAdapterIfEnabled({
    enabled: options.headlessAdapter === true || !tunnelActive,
    command: 'chat',
    interactive: !noninteractive,
    plan: currentPlanData
      ? {
          id: currentPlanData.id,
          uuid: currentPlanData.uuid,
          title: currentPlanData.title,
        }
      : undefined,
    callback: async () => {
      try {
        if (workspaceMode) {
          currentBaseDir = configRepoRoot;

          // --plan implies auto-workspace selection when no explicit workspace option is set
          const useAutoWorkspace =
            options.autoWorkspace === true ||
            (options.plan !== undefined && !options.workspace && !options.newWorkspace);

          // When --plan is provided without --base, derive branch from plan data
          let baseBranch = options.base;
          if (!baseBranch && currentPlanData) {
            baseBranch = currentPlanData.branch ?? generateBranchNameFromPlan(currentPlanData);
          }

          const workspaceResult = await setupWorkspace(
            {
              workspace: options.workspace,
              autoWorkspace: useAutoWorkspace,
              newWorkspace: options.newWorkspace,
              nonInteractive: options.nonInteractive,
              requireWorkspace: false,
              createBranch: false,
              planId: currentPlanData?.id,
              planUuid: currentPlanData?.uuid,
              base: baseBranch,
              allowPrimaryWorkspaceWhenLocked: true,
            },
            currentBaseDir,
            currentPlanFile || undefined,
            config,
            'tim chat'
          );
          currentBaseDir = workspaceResult.baseDir;
          currentPlanFile = workspaceResult.planFile;
          touchedWorkspacePath = currentBaseDir;

          if (path.resolve(currentBaseDir) !== path.resolve(configRepoRoot)) {
            roundTripContext = await prepareWorkspaceRoundTrip({
              workspacePath: currentBaseDir,
              workspaceSyncEnabled: options.workspaceSync !== false,
              branchCreatedDuringSetup: workspaceResult.branchCreatedDuringSetup,
            });
          }

          if (roundTripContext) {
            await runPreExecutionWorkspaceSync(roundTripContext);
          }

          if (currentPlanData) {
            await updateWorkspaceDescriptionFromPlan(currentBaseDir, currentPlanData);
          }
        }

        const executor = buildExecutorAndLog(
          executorName,
          {
            ...sharedExecutorOptions,
            baseDir: currentBaseDir,
          },
          config
        );
        const promptForExecution =
          executorName === CodexCliExecutorName && codexAppServerEnabled ? (prompt ?? '') : prompt;

        await executor.execute(promptForExecution, {
          planId: currentPlanData?.id ? String(currentPlanData.id) : 'chat',
          planTitle: currentPlanData?.title || 'Chat Session',
          planFilePath: currentPlanFile,
          executionMode: 'bare',
        });

        if (currentPlanFile) {
          // force:true is correct here: the executor just wrote this file and it is authoritative
          const updatedPlan = await readPlanFile(currentPlanFile);
          await syncPlanToDb(updatedPlan, {
            cwdForIdentity: currentBaseDir,
            force: true,
            throwOnError: true,
          });
        }

        if (options.commit) {
          await commitAll('workspace chat session', currentBaseDir);
        }
      } catch (err) {
        executionError = err;
      } finally {
        let roundTripError: unknown;
        // Post-sync always runs when workspace roundtrip is active (matching generate/agent).
        // It commits and pushes as part of the workspace lifecycle, independent of --commit.
        if (roundTripContext) {
          try {
            await runPostExecutionWorkspaceSync(roundTripContext, 'workspace chat session');
          } catch (err) {
            roundTripError = err;
          }
        }

        if (touchedWorkspacePath) {
          try {
            touchWorkspaceInfo(touchedWorkspacePath);
          } catch (err) {
            warn(`Failed to update workspace last used time: ${err as Error}`);
          }
        }

        if (executionError) {
          if (roundTripError) {
            warn(`Workspace sync failed after chat error: ${roundTripError as Error}`);
          }
          throw executionError;
        }

        if (roundTripError) {
          throw roundTripError;
        }
      }
    },
  });
}
