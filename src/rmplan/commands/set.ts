import { getGitRoot } from '../../common/git.js';
import { log } from '../../logging.js';
import { readPlanFile, writePlanFile, resolvePlanFile } from '../plans.js';
import type { Priority } from '../planSchema.js';

type Status = 'pending' | 'in_progress' | 'done' | 'cancelled';

export interface SetOptions {
  planFile: string;
  priority?: Priority;
  status?: Status;
  dependsOn?: number[];
  noDependsOn?: number[];
  rmfilter?: string[];
  issue?: string[];
  noIssue?: string[];
  doc?: string[];
  noDoc?: string[];
}

export async function handleSetCommand(
  planFile: string,
  options: SetOptions,
  globalOpts: any
): Promise<void> {
  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts?.config);
  options.planFile = resolvedPlanFile;
  const plan = await readPlanFile(options.planFile);
  let modified = false;

  // Update priority
  if (options.priority) {
    plan.priority = options.priority;
    modified = true;
    log(`Updated priority to ${options.priority}`);
  }

  // Update status
  if (options.status) {
    plan.status = options.status;
    modified = true;
    log(`Updated status to ${options.status}`);
  }

  // Add dependencies
  if (options.dependsOn && options.dependsOn.length > 0) {
    if (!plan.dependencies) {
      plan.dependencies = [];
    }
    for (const dep of options.dependsOn) {
      if (!plan.dependencies.includes(dep)) {
        plan.dependencies.push(dep);
        modified = true;
        log(`Added dependency: ${dep}`);
      } else {
        log(`Dependency already exists: ${dep}`);
      }
    }
  }

  // Remove dependencies
  if (options.noDependsOn && options.noDependsOn.length > 0) {
    if (plan.dependencies) {
      const originalLength = plan.dependencies.length;
      plan.dependencies = plan.dependencies.filter((dep) => !options.noDependsOn!.includes(dep));
      if (plan.dependencies.length < originalLength) {
        modified = true;
        log(`Removed ${originalLength - plan.dependencies.length} dependencies`);
      }
    }
  }

  // Update rmfilter
  if (options.rmfilter && options.rmfilter.length > 0) {
    plan.rmfilter = options.rmfilter;
    modified = true;
    log(`Updated rmfilter patterns`);
  }

  // Add issue URLs
  if (options.issue && options.issue.length > 0) {
    if (!plan.issue) {
      plan.issue = [];
    }
    for (const issueUrl of options.issue) {
      if (!plan.issue.includes(issueUrl)) {
        plan.issue.push(issueUrl);
        modified = true;
        log(`Added issue URL: ${issueUrl}`);
      } else {
        log(`Issue URL already exists: ${issueUrl}`);
      }
    }
  }

  // Remove issue URLs
  if (options.noIssue && options.noIssue.length > 0) {
    if (plan.issue) {
      const originalLength = plan.issue.length;
      plan.issue = plan.issue.filter((url) => !options.noIssue!.includes(url));
      if (plan.issue.length < originalLength) {
        modified = true;
        log(`Removed ${originalLength - plan.issue.length} issue URLs`);
      }
    }
  }

  // Add documentation paths
  if (options.doc && options.doc.length > 0) {
    if (!plan.docs) {
      plan.docs = [];
    }
    for (const docUrl of options.doc) {
      if (!plan.docs.includes(docUrl)) {
        plan.docs.push(docUrl);
        modified = true;
        log(`Added documentation path: ${docUrl}`);
      } else {
        log(`Documentation path already exists: ${docUrl}`);
      }
    }
  }

  // Remove documentation paths
  if (options.noDoc && options.noDoc.length > 0) {
    if (plan.docs) {
      const originalLength = plan.docs.length;
      plan.docs = plan.docs.filter((url: string) => !options.noDoc!.includes(url));
      if (plan.docs.length < originalLength) {
        modified = true;
        log(`Removed ${originalLength - plan.docs.length} documentation paths`);
      }
    }
  }

  if (modified) {
    plan.updatedAt = new Date().toISOString();
    await writePlanFile(options.planFile, plan);
    log(`Plan ${options.planFile} updated successfully`);
  } else {
    log('No changes made');
  }
}
