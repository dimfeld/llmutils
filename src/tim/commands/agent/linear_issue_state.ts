import { getIssueTracker } from '../../../common/issue_tracker/factory.js';
import { log, warn } from '../../../logging.js';
import type { TimConfig } from '../../configSchema.js';
import type { PlanSchema } from '../../planSchema.js';

export async function moveLinearIssuesToInProgressForAgentRun(
  planData: PlanSchema,
  config: TimConfig,
  projectId?: number
): Promise<void> {
  if ((config.issueTracker ?? 'github') !== 'linear') {
    return;
  }

  const issueRefs = [...new Set(planData.issue ?? [])];
  if (issueRefs.length === 0) {
    return;
  }

  let issueTracker;
  try {
    issueTracker = await getIssueTracker(config, { projectId });
  } catch (err) {
    warn(`Failed to initialize Linear issue tracker for agent startup: ${err as Error}`);
    return;
  }

  if (!issueTracker.transitionIssueToInProgressIfReady) {
    return;
  }

  for (const issueRef of issueRefs) {
    if (!issueTracker.parseIssueIdentifier(issueRef)) {
      continue;
    }

    try {
      const result = await issueTracker.transitionIssueToInProgressIfReady(issueRef);
      if (result.changed) {
        log(
          `Moved Linear issue ${result.identifier} from ${result.fromState} to ${result.toState}.`
        );
      } else if (result.reason === 'target-state-missing') {
        warn(`Linear issue ${result.identifier} has no "In Progress" workflow state to move to.`);
      }
    } catch (err) {
      warn(`Failed to update Linear issue ${issueRef} before agent run: ${err as Error}`);
    }
  }
}
