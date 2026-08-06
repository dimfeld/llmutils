import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

import type { Octokit } from 'octokit';

import { secureWrite } from '../fs.js';
import type { PrStatusCheckRun } from './pr_status.js';
import { FAILURE_CHECK_CONCLUSIONS } from './required_check_rollup.js';

export interface ParsedActionsDetailsUrl {
  owner: string;
  repo: string;
  runId: number;
  jobId?: number;
}

type ActionsWorkflowJob = Awaited<
  ReturnType<Octokit['rest']['actions']['listJobsForWorkflowRun']>
>['data']['jobs'][number];

type ActionsWorkflowRun = Awaited<
  ReturnType<Octokit['rest']['actions']['listWorkflowRunsForRepo']>
>['data']['workflow_runs'][number];

export type WorkflowJob = ActionsWorkflowJob & {
  steps: NonNullable<ActionsWorkflowJob['steps']>;
};

export interface DownloadJobLogResult {
  content: string | null;
  error?: string;
}

export type FailingCheckLogInput = Pick<
  PrStatusCheckRun,
  'name' | 'source' | 'conclusion' | 'detailsUrl'
> & {
  required: boolean;
};

export interface FailingCheckLogManifestEntry {
  checkName: string;
  source: PrStatusCheckRun['source'];
  conclusion: PrStatusCheckRun['conclusion'];
  detailsUrl: string | null;
  logPath: string | null;
  failedSteps: string[];
  required: boolean;
  error?: string;
}

export interface CollectFailingCheckLogsOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  headSha: string;
  failingChecks: readonly FailingCheckLogInput[];
  destDir: string;
  concurrency?: number;
}

export const DEFAULT_LOG_DOWNLOAD_CONCURRENCY = 4;
export const MAX_LOG_DOWNLOAD_CONCURRENCY = 4;

function parsePositiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseRepositorySegment(value: string): string | null {
  const decoded = decodePathSegment(value);
  if (!decoded || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(decoded)) {
    return null;
  }

  return decoded;
}

function parseJobIdFromPath(pathSegments: string[]): number | null | undefined {
  if (pathSegments.length === 0) {
    return undefined;
  }

  if (pathSegments.length === 2 && pathSegments[0] === 'job') {
    return parsePositiveInteger(pathSegments[1]);
  }

  if (pathSegments.length === 2 && pathSegments[0] === 'attempts') {
    return parsePositiveInteger(pathSegments[1]) === null ? null : undefined;
  }

  if (pathSegments.length === 4 && pathSegments[0] === 'attempts' && pathSegments[2] === 'job') {
    return parsePositiveInteger(pathSegments[1]) === null
      ? null
      : parsePositiveInteger(pathSegments[3]);
  }

  if (pathSegments.length === 4 && pathSegments[0] === 'job' && pathSegments[2] === 'attempts') {
    return parsePositiveInteger(pathSegments[3]) === null
      ? null
      : parsePositiveInteger(pathSegments[1]);
  }

  return null;
}

export function parseActionsDetailsUrl(url: string): ParsedActionsDetailsUrl | null {
  if (url.trim() !== url) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.hostname !== 'github.com' ||
    parsedUrl.port !== '' ||
    parsedUrl.username !== '' ||
    parsedUrl.password !== ''
  ) {
    return null;
  }

  const rawPathSegments = parsedUrl.pathname.split('/');
  if (rawPathSegments[0] !== '') {
    return null;
  }

  if (rawPathSegments.at(-1) === '') {
    rawPathSegments.pop();
  }

  if (rawPathSegments.slice(1).some((segment) => segment === '')) {
    return null;
  }

  const pathSegments = rawPathSegments.slice(1).map((segment) => decodePathSegment(segment));
  if (pathSegments.some((segment) => segment === null)) {
    return null;
  }

  const decodedPathSegments = pathSegments as string[];
  if (
    decodedPathSegments.length < 5 ||
    decodedPathSegments[2] !== 'actions' ||
    decodedPathSegments[3] !== 'runs'
  ) {
    return null;
  }

  const owner = parseRepositorySegment(decodedPathSegments[0]);
  const repo = parseRepositorySegment(decodedPathSegments[1]);
  const runId = parsePositiveInteger(decodedPathSegments[4]);
  if (!owner || !repo || runId === null) {
    return null;
  }

  const jobId = parseJobIdFromPath(decodedPathSegments.slice(5));
  if (jobId === null) {
    return null;
  }

  return jobId === undefined ? { owner, repo, runId } : { owner, repo, runId, jobId };
}

export async function listRunJobs(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number
): Promise<WorkflowJob[]> {
  const jobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
    owner,
    repo,
    run_id: runId,
    filter: 'latest',
  });

  return jobs.map((job) => ({
    ...job,
    steps: job.steps ?? [],
  }));
}

function getHttpStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  if ('status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }

  if (!('response' in error)) {
    return null;
  }

  const response = (error as { response?: unknown }).response;
  if (typeof response !== 'object' || response === null || !('status' in response)) {
    return null;
  }

  const responseStatus = (response as { status?: unknown }).status;
  return typeof responseStatus === 'number' ? responseStatus : null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSystemicHttpError(error: unknown): boolean {
  const status = getHttpStatus(error);
  return status === 401 || status === 403 || status === 429;
}

function decodeLogContent(content: unknown, jobId: number): string {
  if (typeof content === 'string') {
    return content;
  }

  if (content instanceof ArrayBuffer) {
    return new TextDecoder().decode(content);
  }

  if (ArrayBuffer.isView(content)) {
    const bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    return new TextDecoder().decode(bytes);
  }

  throw new TypeError(`Expected plaintext or binary logs for GitHub Actions job ${jobId}`);
}

export async function downloadJobLog(
  octokit: Octokit,
  owner: string,
  repo: string,
  jobId: number
): Promise<DownloadJobLogResult> {
  try {
    const response = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
      owner,
      repo,
      job_id: jobId,
    });
    return { content: decodeLogContent(response.data as unknown, jobId) };
  } catch (error) {
    if (getHttpStatus(error) !== 404) {
      throw error;
    }

    return {
      content: null,
      error: `GitHub Actions logs for job ${jobId} are unavailable: ${getErrorMessage(error)} (logs may have expired)`,
    };
  }
}

function validateConcurrency(concurrency: number | undefined): number {
  if (concurrency === undefined) {
    return DEFAULT_LOG_DOWNLOAD_CONCURRENCY;
  }

  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError('Log download concurrency must be a positive safe integer');
  }

  return Math.min(concurrency, MAX_LOG_DOWNLOAD_CONCURRENCY);
}

function getRunCacheKey(owner: string, repo: string, runId: number): string {
  return `${owner}\u0000${repo}\u0000${runId}`;
}

function findMatchingJob(
  jobs: readonly WorkflowJob[],
  checkName: string,
  jobId: number | undefined
): WorkflowJob | null {
  if (jobId !== undefined) {
    const jobWithMatchingId = jobs.find((job) => job.id === jobId);
    if (jobWithMatchingId) {
      return jobWithMatchingId;
    }
  }

  return jobs.find((job) => job.name === checkName) ?? null;
}

function getFailedStepNames(job: WorkflowJob): string[] {
  return job.steps
    .filter((step) => FAILURE_CHECK_CONCLUSIONS.has(step.conclusion ?? ''))
    .map((step) => step.name);
}

function isFailingWorkflowJob(job: WorkflowJob): boolean {
  return FAILURE_CHECK_CONCLUSIONS.has(job.conclusion ?? '');
}

function sanitizeCheckName(checkName: string): string {
  const sanitized = checkName
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);

  const baseName = sanitized || 'check';

  // These names are reserved device names on Windows, even when an extension
  // is appended. Prefix them so a check named, for example, "CON" can still
  // be written safely on every supported platform.
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(baseName)) {
    return `check-${baseName}`;
  }

  return baseName;
}

function allocateLogFilename(checkName: string, usedFilenames: Set<string>): string {
  const baseName = sanitizeCheckName(checkName);
  let suffix = 1;

  while (true) {
    const filename = `${baseName}${suffix === 1 ? '' : `-${suffix}`}.log`;
    const filenameKey = filename.toLocaleLowerCase('en-US');
    if (!usedFilenames.has(filenameKey)) {
      usedFilenames.add(filenameKey);
      return filename;
    }

    suffix += 1;
  }
}

function getUnresolvedJobError(
  check: FailingCheckLogInput,
  reason: string,
  detailsUrl: string | null
): string {
  const linkContext = detailsUrl ? ` Investigate ${detailsUrl}.` : '';
  return `${reason} for failing check "${check.name}".${linkContext}`;
}

function getWorkflowRunsForHeadSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string
): Promise<ActionsWorkflowRun[]> {
  return octokit.paginate(octokit.rest.actions.listWorkflowRunsForRepo, {
    owner,
    repo,
    head_sha: headSha,
  });
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const itemIndex = nextIndex;
      nextIndex += 1;
      if (itemIndex >= items.length) {
        return;
      }

      await worker(items[itemIndex]);
    }
  }

  const workerCount = Math.min(items.length, concurrency);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

interface ResolvedFailingCheckJob {
  index: number;
  check: FailingCheckLogInput;
  owner: string;
  repo: string;
  job: WorkflowJob;
  relativeLogPath: string;
}

export async function collectFailingCheckLogs(
  options: CollectFailingCheckLogsOptions
): Promise<FailingCheckLogManifestEntry[]> {
  const downloadConcurrency = validateConcurrency(options.concurrency);
  const absoluteDestDir = path.resolve(options.destDir);
  const manifests: FailingCheckLogManifestEntry[] = options.failingChecks.map((check) => ({
    checkName: check.name,
    source: check.source,
    conclusion: check.conclusion,
    detailsUrl: check.detailsUrl,
    logPath: null,
    failedSteps: [],
    required: check.required,
  }));

  const jobsByRun = new Map<string, Promise<WorkflowJob[]>>();
  const getJobs = (owner: string, repo: string, runId: number): Promise<WorkflowJob[]> => {
    const cacheKey = getRunCacheKey(owner, repo, runId);
    const cachedJobs = jobsByRun.get(cacheKey);
    if (cachedJobs) {
      return cachedJobs;
    }

    const jobs = listRunJobs(options.octokit, owner, repo, runId);
    jobsByRun.set(cacheKey, jobs);
    return jobs;
  };

  let workflowRunsForHeadSha: Promise<ActionsWorkflowRun[]> | undefined;
  const fallbackJobsByName = new Map<string, Promise<WorkflowJob | null>>();
  const findFallbackJob = (check: FailingCheckLogInput): Promise<WorkflowJob | null> => {
    const cachedJob = fallbackJobsByName.get(check.name);
    if (cachedJob) {
      return cachedJob;
    }

    const jobPromise = (async (): Promise<WorkflowJob | null> => {
      workflowRunsForHeadSha ??= getWorkflowRunsForHeadSha(
        options.octokit,
        options.owner,
        options.repo,
        options.headSha
      );
      const workflowRuns = await workflowRunsForHeadSha;
      let lastJobsError: unknown;

      for (const workflowRun of workflowRuns) {
        let jobs: WorkflowJob[];
        try {
          jobs = await getJobs(options.owner, options.repo, workflowRun.id);
        } catch (error) {
          if (isSystemicHttpError(error)) {
            throw error;
          }
          lastJobsError = error;
          continue;
        }

        const job = findMatchingJob(jobs, check.name, undefined);
        if (job && isFailingWorkflowJob(job)) {
          return job;
        }
      }

      if (lastJobsError) {
        throw lastJobsError;
      }

      return null;
    })();
    fallbackJobsByName.set(check.name, jobPromise);
    return jobPromise;
  };

  const resolvedJobs: ResolvedFailingCheckJob[] = [];
  for (let index = 0; index < options.failingChecks.length; index += 1) {
    const check = options.failingChecks[index];
    try {
      const parsedDetailsUrl = check.detailsUrl ? parseActionsDetailsUrl(check.detailsUrl) : null;
      let resolvedJob: ResolvedFailingCheckJob | null;

      if (parsedDetailsUrl) {
        const jobs = await getJobs(
          parsedDetailsUrl.owner,
          parsedDetailsUrl.repo,
          parsedDetailsUrl.runId
        );
        const job = findMatchingJob(jobs, check.name, parsedDetailsUrl.jobId);
        resolvedJob = job
          ? {
              index,
              check,
              owner: parsedDetailsUrl.owner,
              repo: parsedDetailsUrl.repo,
              job,
              relativeLogPath: '',
            }
          : null;
        if (!resolvedJob) {
          manifests[index].error = getUnresolvedJobError(
            check,
            `No latest-attempt GitHub Actions job matched workflow run ${parsedDetailsUrl.runId}`,
            check.detailsUrl
          );
          continue;
        }
      } else {
        const fallbackJob = await findFallbackJob(check);
        if (!fallbackJob) {
          manifests[index].error = getUnresolvedJobError(
            check,
            `No GitHub Actions job matched head SHA ${options.headSha}`,
            check.detailsUrl
          );
          continue;
        }
        resolvedJob = {
          index,
          check,
          owner: options.owner,
          repo: options.repo,
          job: fallbackJob,
          relativeLogPath: '',
        };
      }

      if (!isFailingWorkflowJob(resolvedJob.job)) {
        manifests[index].error = getUnresolvedJobError(
          check,
          `The matched GitHub Actions job did not have a failing conclusion (${resolvedJob.job.conclusion ?? 'unknown'})`,
          check.detailsUrl
        );
        continue;
      }

      manifests[index].failedSteps = getFailedStepNames(resolvedJob.job);
      resolvedJobs.push(resolvedJob);
    } catch (error) {
      if (isSystemicHttpError(error)) {
        throw error;
      }
      manifests[index].error = getErrorMessage(error);
    }
  }

  if (resolvedJobs.length === 0) {
    return manifests;
  }

  await mkdir(absoluteDestDir, { recursive: true });
  const usedFilenames = new Set<string>();
  for (const resolvedJob of resolvedJobs) {
    resolvedJob.relativeLogPath = allocateLogFilename(resolvedJob.check.name, usedFilenames);
  }

  await runWithConcurrency(resolvedJobs, downloadConcurrency, async (resolvedJob) => {
    const manifest = manifests[resolvedJob.index];
    try {
      const downloadedLog = await downloadJobLog(
        options.octokit,
        resolvedJob.owner,
        resolvedJob.repo,
        resolvedJob.job.id
      );
      if (downloadedLog.content === null) {
        manifest.error = downloadedLog.error ?? 'GitHub Actions returned no job log content';
        return;
      }

      await secureWrite(absoluteDestDir, resolvedJob.relativeLogPath, downloadedLog.content);
      manifest.logPath = path.join(absoluteDestDir, resolvedJob.relativeLogPath);
    } catch (error) {
      if (isSystemicHttpError(error)) {
        throw error;
      }
      manifest.error = getErrorMessage(error);
    }
  });

  return manifests;
}
