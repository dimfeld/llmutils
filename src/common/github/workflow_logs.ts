import type { Octokit } from 'octokit';

export interface ParsedActionsDetailsUrl {
  owner: string;
  repo: string;
  runId: number;
  jobId?: number;
}

type ActionsWorkflowJob = Awaited<
  ReturnType<Octokit['rest']['actions']['listJobsForWorkflowRun']>
>['data']['jobs'][number];

export type WorkflowJob = ActionsWorkflowJob & {
  steps: NonNullable<ActionsWorkflowJob['steps']>;
};

export interface DownloadJobLogResult {
  content: string | null;
  error?: string;
}

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
    const content = response.data as unknown;

    if (typeof content !== 'string') {
      throw new TypeError(`Expected plaintext logs for GitHub Actions job ${jobId}`);
    }

    return { content };
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
