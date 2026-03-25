import type { Command } from 'commander';
import { log } from '../../logging.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import {
  materializeAndPruneRelatedPlans,
  materializePlan,
  parsePlanId,
  resolveProjectContext,
} from '../plan_materialize.js';

export async function handleMaterializeCommand(
  planIdArg: string,
  _options: Record<string, never>,
  _command: Command
): Promise<void> {
  const planId = parsePlanId(planIdArg);
  const repository = await getRepositoryIdentity();
  const context = await resolveProjectContext(repository.gitRoot);

  const planPath = await materializePlan(planId, repository.gitRoot, { context });
  await materializeAndPruneRelatedPlans(planId, repository.gitRoot, context);

  log(planPath);
}
