import chalk from 'chalk';

import { log, warn } from '../../logging.js';
import type { ClaimPlanResult } from './claim_plan.js';

export interface ClaimLoggingOptions {
  planLabel: string;
  workspacePath: string;
  user: string | null;
  quiet?: boolean;
}

export function logClaimOutcome(
  result: ClaimPlanResult,
  { planLabel, workspacePath, user, quiet = false }: ClaimLoggingOptions
): void {
  if (!quiet) {
    for (const message of result.warnings) {
      warn(`${chalk.yellow('⚠')} ${message}`);
    }
  }

  if (!quiet) {
    if (result.persisted) {
      const actionDetails: string[] = [];
      if (result.created) {
        actionDetails.push('created assignment');
      } else if (result.addedWorkspace) {
        actionDetails.push('added workspace');
      }
      if (result.addedUser && user) {
        actionDetails.push(`added user ${user}`);
      }
      const suffix = actionDetails.length > 0 ? ` (${actionDetails.join(', ')})` : '';
      log(`${chalk.green('✓')} Claimed plan ${planLabel} in workspace ${workspacePath}${suffix}`);
      return;
    }

    log(`${chalk.yellow('•')} Plan ${planLabel} is already claimed in workspace ${workspacePath}`);
    if (user) {
      log(`  User: ${user}`);
    }
  }
}
