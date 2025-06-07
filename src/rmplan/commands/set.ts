// Command handler for 'rmplan set'
// Updates properties like priority, status, dependencies, and rmfilter for a plan

import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanFile, readPlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';

type SetOptions = {
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  status?: 'pending' | 'in_progress' | 'done' | 'cancelled';
  dependsOn?: string[];
  noDependsOn?: string[];
  rmfilter?: string[];
  issue?: string[];
  noIssue?: string[];
};

export async function handleSetCommand(planFile: string, options: SetOptions, command: any) {
  const globalOpts = command.parent.opts();
  
  try {
    const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
    
    // Read the current plan
    const plan = await readPlanFile(resolvedPlanFile);
    
    // Track what we're updating for logging
    const updates: string[] = [];
    
    // Update priority if provided
    if (options.priority) {
      plan.priority = options.priority;
      updates.push(`priority: ${options.priority}`);
    }
    
    // Update status if provided
    if (options.status) {
      plan.status = options.status;
      updates.push(`status: ${options.status}`);
    }
    
    // Handle dependencies
    if (options.dependsOn || options.noDependsOn) {
      // Initialize dependencies array if it doesn't exist
      if (!plan.dependencies) {
        plan.dependencies = [];
      }
      
      // Add new dependencies
      if (options.dependsOn) {
        for (const dep of options.dependsOn) {
          if (!plan.dependencies.includes(dep)) {
            plan.dependencies.push(dep);
            updates.push(`added dependency: ${dep}`);
          }
        }
      }
      
      // Remove dependencies
      if (options.noDependsOn) {
        for (const dep of options.noDependsOn) {
          const index = plan.dependencies.indexOf(dep);
          if (index > -1) {
            plan.dependencies.splice(index, 1);
            updates.push(`removed dependency: ${dep}`);
          }
        }
      }
    }
    
    // Update rmfilter if provided
    if (options.rmfilter) {
      plan.rmfilter = options.rmfilter;
      updates.push(`rmfilter: [${options.rmfilter.join(', ')}]`);
    }
    
    // Handle issue URLs
    if (options.issue || options.noIssue) {
      // Initialize issue array if it doesn't exist
      if (!plan.issue) {
        plan.issue = [];
      }
      
      // Add new issue URLs
      if (options.issue) {
        for (const issueUrl of options.issue) {
          if (!plan.issue.includes(issueUrl)) {
            plan.issue.push(issueUrl);
            updates.push(`added issue: ${issueUrl}`);
          }
        }
      }
      
      // Remove issue URLs
      if (options.noIssue) {
        for (const issueUrl of options.noIssue) {
          const index = plan.issue.indexOf(issueUrl);
          if (index > -1) {
            plan.issue.splice(index, 1);
            updates.push(`removed issue: ${issueUrl}`);
          }
        }
      }
    }
    
    // Set updatedAt timestamp
    plan.updatedAt = new Date().toISOString();
    
    // Write the updated plan back to file
    await writePlanFile(resolvedPlanFile, plan);
    
    // Log what was updated
    if (updates.length > 0) {
      log(`Updated plan ${plan.id || 'unknown'}: ${updates.join(', ')}`);
    } else {
      log('No changes made to the plan');
    }
    
  } catch (error) {
    throw new Error(`Failed to update plan: ${(error as Error).message}`);
  }
}