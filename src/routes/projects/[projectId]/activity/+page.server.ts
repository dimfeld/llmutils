import type { Database } from 'bun:sqlite';
import { getServerContext } from '$lib/server/init.js';
import { getLatestReviewByPlanUuid, getLatestReviewByPrUrl } from '$tim/db/review.js';
import { listRecentJobs, type JobRow } from '$tim/db/job.js';
import type { PageServerLoad } from './$types';

export interface ActivityJob extends JobRow {
  /** Relative or external URL to the job's primary output, or null if none. */
  outputHref: string | null;
  /** True when {@link outputHref} points off-site (e.g. a GitHub PR). */
  outputExternal: boolean;
}

/** Job types whose natural output is a generated review guide. */
const REVIEW_JOB_TYPES = new Set(['review', 'review-guide', 'autoreview']);
/** Job types whose natural output is the created/updated pull request. */
const PR_JOB_TYPES = new Set(['pr-create', 'pr-fix']);

function planHref(job: JobRow): string | null {
  if (job.project_id == null || !job.plan_uuid) {
    return null;
  }
  return `/projects/${job.project_id}/plans/${job.plan_uuid}`;
}

function prHref(job: JobRow): { href: string; external: boolean } | null {
  if (job.project_id != null && job.pr_number != null) {
    return { href: `/projects/${job.project_id}/prs/${job.pr_number}`, external: false };
  }
  if (job.pr_url) {
    return { href: job.pr_url, external: true };
  }
  return null;
}

function reviewHref(job: JobRow, reviewId: number): string | null {
  if (job.project_id == null) {
    return null;
  }
  if (job.pr_number != null) {
    return `/projects/${job.project_id}/prs/${job.pr_number}/reviews/${reviewId}`;
  }
  if (job.plan_uuid) {
    return `/projects/${job.project_id}/plans/${job.plan_uuid}/reviews/${reviewId}`;
  }
  return null;
}

function resolveOutput(db: Database, job: JobRow): { href: string | null; external: boolean } {
  // Review-style jobs jump to the latest generated guide for their target.
  if (REVIEW_JOB_TYPES.has(job.job_type)) {
    let review = null;
    if (job.plan_uuid) {
      review = getLatestReviewByPlanUuid(db, job.plan_uuid, {
        projectId: job.project_id ?? undefined,
      });
    }
    if (!review && job.pr_url) {
      review = getLatestReviewByPrUrl(db, job.pr_url, {
        projectId: job.project_id ?? undefined,
      });
    }
    if (review) {
      const href = reviewHref(job, review.id);
      if (href) {
        return { href, external: false };
      }
    }
    // Fall back to the plan or PR if no guide is stored yet.
    const pr = prHref(job);
    if (job.plan_uuid) {
      return { href: planHref(job), external: false };
    }
    if (pr) {
      return pr;
    }
    return { href: null, external: false };
  }

  // Proof jobs jump to the plan's artifacts.
  if (job.job_type === 'proof' && job.project_id != null && job.plan_uuid) {
    return {
      href: `/projects/${job.project_id}/plans/${job.plan_uuid}/artifacts`,
      external: false,
    };
  }

  // PR jobs jump to the pull request.
  if (PR_JOB_TYPES.has(job.job_type)) {
    const pr = prHref(job);
    if (pr) {
      return pr;
    }
    return { href: planHref(job), external: false };
  }

  // Everything else (agent, generate, rebase, chat, ...) jumps to the plan,
  // falling back to a linked PR when there is no plan.
  const plan = planHref(job);
  if (plan) {
    return { href: plan, external: false };
  }
  const pr = prHref(job);
  if (pr) {
    return pr;
  }
  return { href: null, external: false };
}

export const load: PageServerLoad = async ({ parent }) => {
  const { projectId } = await parent();
  const { db } = await getServerContext();

  const jobs = listRecentJobs(db, {
    projectId: projectId === 'all' ? 'all' : Number(projectId),
  });

  const activity: ActivityJob[] = jobs.map((job) => {
    const output = resolveOutput(db, job);
    return { ...job, outputHref: output.href, outputExternal: output.external };
  });

  return { activity };
};
