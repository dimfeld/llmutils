import { log, warn } from '../../logging.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { compareArtifactsByFilename } from '../../common/artifact_sort.js';
import { artifactMediaPath, uploadFile } from '../../common/media_host/client.js';
import {
  findPullRequestCommentByMarker,
  postPullRequestComment,
  updatePullRequestComment,
} from '../../common/github/pull_requests.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getMediaHostUploadConfig } from '../configSchema.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { resolveProjectContext } from '../plan_materialize.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { parsePlanIdFromCliArg, resolvePlanByUuid } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import {
  listArtifactsForPlanUuid,
  type PlanArtifactWithTransferState,
} from '../artifacts/service.js';
import { getDatabase } from '../db/database.js';
import { getPrStatusForPlan } from '../db/pr_status.js';
import { gatherPrContext, type PrReviewContext } from '../utils/pr_context_gathering.js';
import {
  buildArtifactCommentBody,
  buildFullReportHtml,
  buildPlanArtifactsCommentMarker,
  isReportArtifactFilename,
  type UploadedArtifactForComment,
} from './upload_artifacts_comment.js';

interface RootCommandLike {
  parent?: RootCommandLike;
  opts?: () => {
    config?: string;
  };
}

export interface UploadArtifactsOptions {
  autoWorkspace?: boolean;
  terminalInput?: boolean;
  pr?: string;
}

function getRootOptions(command: RootCommandLike | undefined): { config?: string } {
  let current = command;
  while (current?.parent) {
    current = current.parent;
  }

  return current?.opts?.() ?? {};
}

function isUploadableArtifact(artifact: PlanArtifactWithTransferState): boolean {
  return artifact.deletedAt == null && artifact.transferState !== 'file-missing';
}

// Detected by filename only, matching buildArtifactCommentBody's filter, so a report.md is always
// consumed as the comment body (never uploaded and then silently dropped from the artifact list).
function isReportArtifact(artifact: PlanArtifactWithTransferState): boolean {
  return isReportArtifactFilename(artifact.filename);
}

async function resolveTargetPrs(options: {
  db: ReturnType<typeof getDatabase>;
  cwd: string;
  planUuid: string;
  plan: PlanSchema;
  explicitPr?: string;
}): Promise<PrReviewContext[]> {
  if (options.explicitPr) {
    return [
      await gatherPrContext({
        db: options.db,
        prUrlOrNumber: options.explicitPr,
        cwd: options.cwd,
      }),
    ];
  }

  const linkedPrs = [
    ...new Set([
      ...(options.plan.pullRequest ?? []),
      ...getPrStatusForPlan(options.db, options.planUuid).map((detail) => detail.status.pr_url),
    ]),
  ];
  const contexts: PrReviewContext[] = [];
  const seenPrUrls = new Set<string>();
  const failures: string[] = [];
  const results = await Promise.allSettled(
    linkedPrs.map(async (prUrl) => ({
      prUrl,
      context: await gatherPrContext({
        db: options.db,
        prUrlOrNumber: prUrl,
        cwd: options.cwd,
      }),
    }))
  );

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]!;
    const prUrl = linkedPrs[index]!;
    if (result.status === 'rejected') {
      failures.push(
        `${prUrl}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
      );
      continue;
    }

    const { context } = result.value;
    if (context.prStatus.state !== 'open') {
      continue;
    }
    if (seenPrUrls.has(context.prUrl)) {
      continue;
    }
    seenPrUrls.add(context.prUrl);
    contexts.push(context);
  }

  if (contexts.length === 0 && failures.length > 0) {
    throw new Error(
      `No linked pull requests could be resolved for plan ${options.plan.id}. ${failures.join('; ')}`
    );
  }

  // Surface partial failures: when some PRs resolve but others fail, the failing PRs would
  // otherwise be silently dropped with no indication that they were skipped.
  for (const failure of failures) {
    warn(`Skipping linked pull request that could not be resolved: ${failure}`);
  }

  return contexts;
}

async function uploadArtifact(options: {
  baseUrl: string;
  apiKey: string;
  planUuid: string;
  artifact: PlanArtifactWithTransferState;
}): Promise<UploadedArtifactForComment> {
  const mediaPath = artifactMediaPath(
    options.planUuid,
    options.artifact.uuid,
    options.artifact.filename
  );
  const result = await uploadFile({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    relativePath: mediaPath,
    body: Bun.file(options.artifact.storagePath),
    contentType: options.artifact.mimeType,
  });

  log(`Uploaded artifact ${options.artifact.filename}: ${result.url}`);

  return {
    filename: options.artifact.filename,
    mimeType: options.artifact.mimeType,
    url: result.url,
    size: result.size,
    // Match report.md relative references against the artifact's original
    // (possibly nested) filename, NOT the deterministic media-host object path.
    relativePath: options.artifact.filename,
  };
}

async function uploadFullReportHtml(options: {
  baseUrl: string;
  apiKey: string;
  planUuid: string;
  html: string;
}): Promise<string> {
  const mediaPath = `tim/plans/${options.planUuid}/report/index.html`;
  const result = await uploadFile({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    relativePath: mediaPath,
    body: options.html,
    contentType: 'text/html; charset=utf-8',
  });

  log(`Uploaded full report: ${result.url}`);
  return result.url;
}

async function upsertArtifactsComment(
  prContext: PrReviewContext,
  marker: string,
  body: string
): Promise<void> {
  const existingComment = await findPullRequestCommentByMarker(
    prContext.owner,
    prContext.repo,
    prContext.prNumber,
    marker
  );

  if (existingComment) {
    const updated = await updatePullRequestComment(
      prContext.owner,
      prContext.repo,
      existingComment.id,
      body
    );
    log(
      `Updated artifacts comment for ${prContext.prUrl}: ${updated.htmlUrl ?? `comment #${updated.id}`}`
    );
  } else {
    const posted = await postPullRequestComment(
      prContext.owner,
      prContext.repo,
      prContext.prNumber,
      body
    );
    log(
      `Posted artifacts comment to ${prContext.prUrl}: ${posted.htmlUrl ?? `comment #${posted.id}`}`
    );
  }
}

export async function handleUploadArtifactsCommand(
  planIdArg: string | number | undefined,
  options: UploadArtifactsOptions,
  rootCommand: RootCommandLike | undefined
): Promise<void> {
  if (planIdArg === undefined) {
    throw new Error('A numeric plan ID is required');
  }

  const globalOpts = getRootOptions(rootCommand);
  const config = await loadEffectiveConfig(globalOpts.config);
  const mediaHost = getMediaHostUploadConfig(config);
  if (!mediaHost) {
    log('Media host is not configured (set mediaHost.baseUrl and the MEDIA_HOST_API_KEY env var).');
    return;
  }

  const planId = typeof planIdArg === 'number' ? planIdArg : parsePlanIdFromCliArg(planIdArg);
  const repoRoot = await resolveRepoRoot(globalOpts.config, process.cwd());
  const context = await resolveProjectContext(repoRoot);
  const planUuid = context.planIdToUuid.get(planId);
  if (!planUuid) {
    throw new Error(`Plan not found: ${planId}`);
  }

  const { plan } = await resolvePlanByUuid(planUuid, repoRoot, { context });
  const planTitle = plan.title ?? 'Untitled plan';
  const artifacts = (await listArtifactsForPlanUuid({ planUuid }))
    .filter(isUploadableArtifact)
    .sort(compareArtifactsByFilename);
  if (artifacts.length === 0) {
    log(`Nothing to upload for plan ${planId}.`);
    return;
  }

  const targetPrs = await resolveTargetPrs({
    db: getDatabase(),
    cwd: repoRoot,
    planUuid,
    plan,
    explicitPr: options.pr,
  });
  if (targetPrs.length === 0) {
    throw new Error(`Plan ${planId} has no open linked pull requests.`);
  }

  await runWithHeadlessAdapterIfEnabled({
    enabled: !isTunnelActive(),
    command: 'upload-artifacts',
    interactive: options.terminalInput !== false,
    plan: {
      id: plan.id,
      uuid: plan.uuid,
      title: planTitle,
    },
    callback: async () => {
      const marker = buildPlanArtifactsCommentMarker(planUuid);
      const reportArtifact = artifacts.find(isReportArtifact);
      const reportMarkdown = reportArtifact
        ? await Bun.file(reportArtifact.storagePath).text()
        : undefined;
      // Exclude every report.md (not just the consumed one) from upload: buildArtifactCommentBody
      // filters all report.md out of the rendered list, so uploading a duplicate would silently
      // lose it.
      const artifactsToUpload = artifacts.filter((artifact) => !isReportArtifact(artifact));
      const uploadedArtifacts = await Promise.all(
        artifactsToUpload.map((artifact) =>
          uploadArtifact({
            baseUrl: mediaHost.baseUrl,
            apiKey: mediaHost.apiKey,
            planUuid,
            artifact,
          })
        )
      );
      const updatedAt = new Date().toISOString();
      const fullReportHtml = buildFullReportHtml({
        planId: plan.id,
        planTitle,
        reportMarkdown,
        artifacts: uploadedArtifacts,
        updatedAt,
      });
      const fullReportUrl = await uploadFullReportHtml({
        baseUrl: mediaHost.baseUrl,
        apiKey: mediaHost.apiKey,
        planUuid,
        html: fullReportHtml,
      });

      const body = buildArtifactCommentBody({
        marker,
        planId: plan.id,
        planTitle,
        reportMarkdown,
        artifacts: uploadedArtifacts,
        fullReportUrl,
        updatedAt,
      });

      // Attempt every target PR even if one fails, so a single failing PR does not abort the
      // others (the CLI error handler calls process.exit, which would kill in-flight posts).
      const results = await Promise.allSettled(
        targetPrs.map((prContext) => upsertArtifactsComment(prContext, marker, body))
      );
      const failures = results.flatMap((result, index) =>
        result.status === 'rejected'
          ? [
              `${targetPrs[index]!.prUrl}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
            ]
          : []
      );
      if (failures.length > 0) {
        throw new Error(`Failed to post artifacts comment to some PRs. ${failures.join('; ')}`);
      }
    },
  });
}
