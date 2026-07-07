import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getCurrentBranchName } from '../../common/git.js';
import { buildReviewGuideDiffview } from '../../lib/utils/markdown_parser.js';
import { log } from '../../logging.js';
import { getDatabase } from '../db/database.js';
import { getLatestReviewGuide, resolveReviewGuideTarget } from './review_guide_manage.js';
import { resolveProjectContextForRepo } from './review_workflow.js';

export interface ReviewGuideDiffviewOptions {
  output?: string;
}

export async function handleReviewGuideDiffviewCommand(
  targetArg: string | undefined,
  options: ReviewGuideDiffviewOptions
): Promise<void> {
  const db = getDatabase();
  const { projectId, repoRoot } = await resolveProjectContextForRepo(db, process.cwd());

  const resolvedTargetArg = targetArg?.trim();
  const target =
    resolvedTargetArg && resolvedTargetArg.length > 0
      ? await resolveReviewGuideTarget(db, projectId, resolvedTargetArg, repoRoot)
      : await resolveCurrentBranchReviewGuideTarget(db, projectId, repoRoot);

  const review = getLatestReviewGuide(target.reviews);
  if (!review) {
    throw new Error(
      `No stored review guide found for ${target.label}. Run 'tim review-guide generate <planId>' or 'tim pr review-guide' first.`
    );
  }

  const fallbackTitle =
    target.kind === 'plan'
      ? (target.plan.title ?? target.label)
      : (target.pr?.title ?? target.label);
  const json = buildReviewGuideDiffview({
    markdown: review.review_guide!,
    fallbackTitle,
  });
  const serialized = JSON.stringify(json, null, 2);
  const outputPath = path.resolve(process.cwd(), options.output ?? 'review-guide.json');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, serialized, 'utf8');

  log(`Wrote diffview JSON: ${outputPath}`);
}

async function resolveCurrentBranchReviewGuideTarget(
  db: ReturnType<typeof getDatabase>,
  projectId: number,
  repoRoot: string
): ReturnType<typeof resolveReviewGuideTarget> {
  const branch = await getCurrentBranchName(repoRoot);
  if (!branch?.trim()) {
    throw new Error(
      'Cannot resolve review guide target because this checkout appears to be in detached HEAD state or has no current branch. Pass a plan ID, branch, or PR URL explicitly.'
    );
  }

  return await resolveReviewGuideTarget(db, projectId, branch, repoRoot);
}
