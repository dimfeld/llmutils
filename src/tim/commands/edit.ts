// Command handler for 'tim edit'
// Opens a plan file in your editor

import type { Command } from 'commander';
import path from 'node:path';
import { editMaterializedPlan } from './materialized_edit.js';
import { resolvePlanFromDbOrSyncFile } from '../ensure_plan_in_db.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import { writePlanFile } from '../plans.js';

export async function handleEditCommand(planArg: string, options: any, _command: Command) {
  const globalOpts = _command.parent?.opts?.() ?? {};
  const repoRoot = await resolveRepoRootForPlanArg(planArg, undefined, globalOpts.config);
  const { plan } = await resolvePlanFromDbOrSyncFile(planArg, repoRoot, repoRoot);
  if (!plan.uuid) {
    throw new Error('Plan must have a UUID to edit');
  }
  await editMaterializedPlan(plan.id, repoRoot, options.editor);

  const directPath = path.isAbsolute(planArg) ? planArg : path.resolve(repoRoot, planArg);
  const directExists = await Bun.file(directPath)
    .stat()
    .then((stats) => stats.isFile())
    .catch(() => false);
  if (directExists) {
    const refreshed = (await resolvePlanFromDbOrSyncFile(plan.uuid, repoRoot, repoRoot)).plan;
    await writePlanFile(directPath, refreshed, {
      cwdForIdentity: repoRoot,
      skipDb: true,
      skipUpdatedAt: true,
    });
  }
}
