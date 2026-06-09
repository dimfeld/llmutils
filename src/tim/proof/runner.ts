import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getChangedFilesOnBranch } from '../../common/git.js';
import type { LoggerAdapter } from '../../logging/adapter.js';
import { MAX_ARTIFACT_BYTES } from '../artifacts/constants.js';
import {
  addArtifactByPlanUuid,
  listArtifactsForPlanUuid,
  softDeleteArtifact,
} from '../artifacts/service.js';
import type { TimConfig } from '../configSchema.js';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { ensureMaterializeDir, resolveProjectContext } from '../plan_materialize.js';
import { resolvePlanByUuid } from '../plans.js';
import { buildTimWorkspaceCommandEnvironmentOptionsForPath } from '../environment_options.js';

const DEFAULT_PROOF_ARTIFACTS_DIR = '.tim/proofs';

export interface ProofResult {
  runId: string;
  attachedArtifactUuids: string[];
  skippedFiles: { path: string; size: number }[];
}

export interface RunProofGenerationOptions {
  planUuid: string;
  gitRoot: string;
  workspacePath: string;
  config: TimConfig;
  runId: string;
  logger: LoggerAdapter;
  /** CLI executor override; takes precedence over config values. */
  executor?: string;
  /** CLI model override; takes precedence over config values. */
  model?: string;
  terminalInput?: boolean;
}

export class ProofNotConfiguredError extends Error {
  constructor() {
    super('Proof generation is not configured for this project.');
    this.name = 'ProofNotConfiguredError';
  }
}

export class ProofRunError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      `Proof generation executor failed: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = 'ProofRunError';
    this.cause = cause;
  }
}

async function clearDirectoryContents(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const entries = await fs.readdir(directory);

  await Promise.all(
    entries.map((entry) => fs.rm(path.join(directory, entry), { recursive: true, force: true }))
  );
}

async function walkFiles(directory: string): Promise<string[]> {
  let entries: Array<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }>;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return await walkFiles(entryPath);
      }
      if (entry.isFile()) {
        return [entryPath];
      }
      return [];
    })
  );

  return files.flat().toSorted((a, b) => a.localeCompare(b));
}

function formatTasks(tasks: Array<{ title: string; done?: boolean }>): string {
  if (tasks.length === 0) {
    return '(none)';
  }

  return tasks.map((task) => `- [${task.done ? 'x' : ' '}] ${task.title}`).join('\n');
}

function buildProofPrompt(options: {
  absoluteArtifactsDir: string;
  artifactsDir: string;
  goal: string;
  details: string;
  tasks: Array<{ title: string; done?: boolean }>;
  changedFiles: string[];
  instructions: string;
}): string {
  return `# Proof Generation Task
You are generating proof artifacts for a completed plan in this repository. These proof artifacts serve two purposes: to show that the plan is completed properly, and to help other developers understand how to use the new features.

Tests, type checking, linting, formatting, and other automated quality gates do not count as proof artifacts. Do not spend time running them just to show they pass; automation already covers that. Proof should demonstrate the feature doing what the plan says it should do, using user-visible behavior, API/CLI behavior, backend state changes, integration behavior, or other direct evidence of the feature in action.

Decide what to demonstrate based on the plan goal, details, task list, and changed files below. First look for "Manual Testing Runbooks" sections in the plan details. Treat those runbooks as the primary instructions for what to demo, and create proof for each runbook. If there are subplans with their own runbook sections in the details, produce proof for each subplan runbook as well. You are encouraged to also create proof for valuable behavior or risks that the runbooks do not cover, especially when changed files or task details reveal additional user-facing behavior, backend behavior, integrations, edge cases, or regressions. Use whatever tools are appropriate (Playwright, scripts, curl, the dev server and database, etc.) to capture screenshots, videos, command transcripts, logs, generated files, or other evidence. Write or copy all output files into ${options.absoluteArtifactsDir}.

Finish by writing report.md in that directory. The top of report.md must state whether the proof matched the plan expectations, failed to match them, or had mixed results, since that success/failure verdict is the most important thing to the reader. After that verdict, summarize what you did, map each runbook to the proof you produced, note any additional proof beyond the runbooks, and list each file you produced. Do not modify source files outside ${options.artifactsDir}. If the work is purely backend / no user-facing surface to demonstrate, still follow any backend/API/CLI runbooks if present; otherwise write a brief report.md explaining that and stop.


## Plan
### Goal
${options.goal}
### Details
${options.details}
### Tasks
${formatTasks(options.tasks)}

## Changed files on this branch
${options.changedFiles.length > 0 ? options.changedFiles.join('\n') : '(none)'}

## Project instructions
${options.instructions}`;
}

async function softDeletePriorProofArtifacts(planUuid: string, config: TimConfig): Promise<void> {
  const artifacts = await listArtifactsForPlanUuid({ planUuid, config });
  const priorProofArtifacts = artifacts.filter((artifact) =>
    artifact.message?.startsWith('tim-proof:')
  );

  for (const artifact of priorProofArtifacts) {
    await softDeleteArtifact(artifact.uuid, { config });
  }
}

export async function runProofGeneration(options: RunProofGenerationOptions): Promise<ProofResult> {
  const proofConfig = options.config.proofGeneration;
  const rawInstructions = proofConfig?.instructions;
  if (!proofConfig || !rawInstructions?.trim()) {
    throw new ProofNotConfiguredError();
  }
  const configuredProof: NonNullable<TimConfig['proofGeneration']> = proofConfig;
  const instructions = rawInstructions;

  const context = await resolveProjectContext(options.gitRoot);
  const { plan, planPath } = await resolvePlanByUuid(options.planUuid, options.gitRoot, {
    context,
  });

  const realWorkspacePath = await fs.realpath(options.workspacePath);
  const artifactsDir = DEFAULT_PROOF_ARTIFACTS_DIR;
  const absoluteArtifactsDir = path.resolve(realWorkspacePath, artifactsDir);

  // Symlink-safe containment: lstat each existing path component between the
  // workspace root and the artifacts directory. Reject if any component is a
  // symlink, since clearDirectoryContents() follows symlinks and could delete
  // files outside the intended directory (whether or not the target escapes
  // the workspace).
  const componentChain: string[] = [];
  for (
    let current = absoluteArtifactsDir;
    current !== realWorkspacePath && current !== path.dirname(current);
    current = path.dirname(current)
  ) {
    componentChain.push(current);
  }
  for (const component of componentChain) {
    try {
      const lst = await fs.lstat(component);
      if (lst.isSymbolicLink()) {
        throw new Error(
          `proof artifacts path contains a symlinked component (${component}); refusing to clear to avoid deleting outside the intended directory`
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }

  // Ensure tim-managed git excludes (which include `.tim/proofs/`) are written
  // to the execution workspace before any proof files land on disk. Otherwise a
  // standalone `tim proof` invocation in a checkout that has never run
  // `tim agent` could leave generated media tracked by git.
  await ensureMaterializeDir(options.gitRoot);

  await clearDirectoryContents(absoluteArtifactsDir);

  const changedFiles = await getChangedFilesOnBranch(options.gitRoot);
  await softDeletePriorProofArtifacts(options.planUuid, options.config);

  const prompt = buildProofPrompt({
    absoluteArtifactsDir,
    artifactsDir,
    goal: plan.goal ?? '',
    details: plan.details ?? '',
    tasks: plan.tasks ?? [],
    changedFiles,
    instructions,
  });

  const executorName =
    options.executor ||
    configuredProof.executor ||
    options.config.defaultExecutor ||
    DEFAULT_EXECUTOR;
  const model =
    options.model ||
    configuredProof.model ||
    options.config.models?.execution ||
    defaultModelForExecutor(executorName, 'execution');
  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: options.workspacePath,
    model,
    terminalInput: options.terminalInput,
    timEnvironment: buildTimWorkspaceCommandEnvironmentOptionsForPath(
      options.config,
      options.workspacePath,
      {
        planId: plan.id,
        planUuid: plan.uuid,
        planFilePath: planPath,
        branch: plan.branch,
      },
      options.gitRoot
    ),
  };
  const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, options.config);

  let executorError: unknown;
  try {
    await executor.execute(prompt, {
      planId: plan.id?.toString() ?? 'unknown',
      planTitle: plan.title ?? 'Proof Generation',
      planFilePath: planPath ?? '',
      executionMode: 'bare',
      captureOutput: 'none',
    });
  } catch (error) {
    executorError = error;
  }

  const attachedArtifactUuids: string[] = [];
  const skippedFiles: { path: string; size: number }[] = [];
  const artifactFiles = await walkFiles(absoluteArtifactsDir);

  if (artifactFiles.length === 0) {
    options.logger.warn(`Proof generation produced no artifacts in ${absoluteArtifactsDir}`);
  }

  for (const filePath of artifactFiles) {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_ARTIFACT_BYTES) {
      options.logger.warn(
        `Skipping oversized proof artifact ${filePath} (${stat.size} bytes; max ${MAX_ARTIFACT_BYTES})`
      );
      skippedFiles.push({ path: filePath, size: stat.size });
      continue;
    }

    const artifact = await addArtifactByPlanUuid({
      planUuid: options.planUuid,
      sourcePath: filePath,
      message: `tim-proof:${options.runId}`,
      config: options.config,
    });
    attachedArtifactUuids.push(artifact.uuid);
  }

  if (executorError) {
    throw new ProofRunError(executorError);
  }

  return {
    runId: options.runId,
    attachedArtifactUuids,
    skippedFiles,
  };
}
