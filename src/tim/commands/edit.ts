// Command handler for 'tim edit'
// Opens a plan file in your editor

import type { Command } from 'commander';
import { editMaterializedPlan } from './materialized_edit.js';
import { resolvePlanByNumericId } from '../plans.js';
import { resolveRepoRoot } from '../plan_repo_root.js';

export async function handleEditCommand(planId: number, options: any, _command: Command) {
  const globalOpts = _command.parent?.opts?.() ?? {};
  const repoRoot = await resolveRepoRoot(globalOpts.config);
  const { plan } = await resolvePlanByNumericId(planId, repoRoot);
  if (!plan.uuid) {
    throw new Error('Plan must have a UUID to edit');
  }
  await editMaterializedPlan(plan.id, repoRoot, options.editor);
}
