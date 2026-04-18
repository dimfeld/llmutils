import type { Command } from 'commander';
import chalk from 'chalk';
import { log } from '../../logging.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import {
  materializeAndPruneRelatedPlans,
  materializePlan,
  resolveProjectContext,
} from '../plan_materialize.js';

export async function handleMaterializeCommand(
  planId: number,
  _options: Record<string, never>,
  _command: Command
): Promise<void> {
  const repository = await getRepositoryIdentity();
  const context = await resolveProjectContext(repository.gitRoot);

  const planPath = await materializePlan(planId, repository.gitRoot, { context });
  await materializeAndPruneRelatedPlans(planId, repository.gitRoot, context);

  log(planPath);
  log(
    `\nEdit the file, then run ${chalk.white(`tim sync ${planId}`)} to save changes back to the database`
  );
}
