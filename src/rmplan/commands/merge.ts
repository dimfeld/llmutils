import { unlink } from 'node:fs/promises';
import { relative, join, isAbsolute } from 'node:path';
import { getGitRoot } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { readAllPlans, readPlanFile, resolvePlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { log, warn } from '../../logging.js';
import { resolveTasksDir } from '../configSchema.js';

interface MergeOptions {
  children?: string[];
  all?: boolean;
}

const progressHeadingRegex = /^( {0,3})##\s+Current Progress\s*$/;
const fenceRegex = /^\s*(```|~~~)/;

interface ProgressSection {
  raw: string;
  content: string;
}

function getHeadingLevel(line: string): number | undefined {
  const match = line.match(/^( {0,3})(#{1,6})\s+\S/);
  if (!match) {
    return undefined;
  }
  return match[2].length;
}

function findProgressSectionRanges(lines: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fenceRegex.test(line)) {
      inFence = !inFence;
    }

    if (inFence) {
      continue;
    }

    if (progressHeadingRegex.test(line)) {
      let j = i + 1;
      let sectionFence: boolean = inFence;

      for (; j < lines.length; j += 1) {
        const nextLine = lines[j];
        if (fenceRegex.test(nextLine)) {
          sectionFence = !sectionFence;
        }
        const headingLevel = sectionFence ? undefined : getHeadingLevel(nextLine);
        if (headingLevel !== undefined && headingLevel <= 2) {
          break;
        }
      }

      ranges.push({ start: i, end: j - 1 });
      i = j - 1;
    }
  }

  return ranges;
}

function extractProgressSections(details?: string): { body: string; sections: ProgressSection[] } {
  if (!details) {
    return { body: '', sections: [] };
  }

  const lines = details.split('\n');
  const ranges = findProgressSectionRanges(lines);

  if (ranges.length === 0) {
    return { body: details.trim(), sections: [] };
  }

  const skipLines = new Array(lines.length).fill(false);
  const sections: ProgressSection[] = [];

  for (const range of ranges) {
    for (let index = range.start; index <= range.end; index += 1) {
      skipLines[index] = true;
    }

    const rawLines = lines.slice(range.start, range.end + 1);
    const contentLines = rawLines.slice(1);

    sections.push({
      raw: rawLines.join('\n').trim(),
      content: contentLines.join('\n').trim(),
    });
  }

  const body = lines
    .filter((_, index) => !skipLines[index])
    .join('\n')
    .trim();

  return { body, sections };
}

function formatProgressSectionLabel(child: PlanSchema & { filename: string }): string {
  if (child.title) {
    return child.title;
  }
  if (child.goal) {
    return child.goal;
  }
  return child.id ? `Plan ${child.id}` : child.filename;
}

function buildMergedProgressSection(
  mainSection: ProgressSection | undefined,
  sections: Array<{ label: string; section: ProgressSection }>
): string | undefined {
  if (!mainSection && sections.length === 0) {
    return undefined;
  }

  if (mainSection && sections.length === 0) {
    return mainSection.raw;
  }

  if (!mainSection && sections.length === 1) {
    return sections[0].section.raw;
  }

  const blocks: string[] = [];

  if (mainSection?.content) {
    blocks.push(mainSection.content);
  }

  const childBlocks = sections
    .map(({ label, section }) => {
      const parts = [`### From ${label}`];
      if (section.content) {
        parts.push(section.content);
      }
      return parts.join('\n');
    })
    .filter((block) => block.trim());

  blocks.push(...childBlocks);

  if (blocks.length === 0) {
    return undefined;
  }

  return `## Current Progress\n${blocks.join('\n\n')}`.trim();
}

export async function handleMergeCommand(planFile: string, options: MergeOptions, command: any) {
  const globalOpts = command.parent.opts();
  const gitRoot = (await getGitRoot()) || process.cwd();
  const config = await loadEffectiveConfig(globalOpts.config);
  const tasksDir = await resolveTasksDir(config);

  // Resolve the main plan file
  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
  const mainPlan = await readPlanFile(resolvedPlanFile);

  if (!mainPlan.id) {
    throw new Error('Main plan must have an ID');
  }

  // Read all plans to find children and handle updates
  const { plans } = await readAllPlans(tasksDir);

  // Find all direct children of the main plan and sort by ID for consistent ordering
  const allChildren = Array.from(plans.values())
    .filter((plan) => plan.parent === mainPlan.id)
    .sort((a, b) => (a.id || 0) - (b.id || 0));

  if (allChildren.length === 0) {
    log('No child plans found to merge');
    return;
  }

  // Determine which children to merge
  let childrenToMerge: (PlanSchema & { filename: string })[];

  if (options.children && options.children.length > 0) {
    // Merge specific children by ID or filename
    childrenToMerge = [];
    for (const childArg of options.children) {
      // Try to parse as number for ID lookup
      const childId = Number(childArg);
      let child: (PlanSchema & { filename: string }) | undefined;

      if (!isNaN(childId)) {
        child = allChildren.find((c) => c.id === childId);
      }

      // If not found by ID, try by filename
      if (!child) {
        const childPath = await resolvePlanFile(childArg, globalOpts.config).catch(() => null);
        if (childPath) {
          child = allChildren.find((c) => c.filename === childPath);
        }
      }

      if (!child) {
        throw new Error(`Child plan not found: ${childArg}`);
      }

      childrenToMerge.push(child);
    }
  } else {
    // Default to merging all direct children
    childrenToMerge = allChildren;
  }

  if (childrenToMerge.length === 0) {
    log('No matching child plans to merge');
    return;
  }

  log(
    `Merging ${childrenToMerge.length} child plan(s) into ${mainPlan.title || `Plan ${mainPlan.id}`}`
  );

  // Collect all dependencies from children
  const allChildDependencies = new Set<number>();
  for (const child of childrenToMerge) {
    if (child.dependencies) {
      for (const dep of child.dependencies) {
        // Don't add the main plan itself as a dependency
        if (dep !== mainPlan.id) {
          allChildDependencies.add(dep);
        }
      }
    }
  }

  // Merge tasks from children into main plan
  const mergedTasks = [...(mainPlan.tasks || [])];
  const mergedDetails: string[] = [];

  const { body: mainDetailsBody, sections: mainProgressSections } = extractProgressSections(
    mainPlan.details
  );
  const mainProgressSection =
    mainProgressSections.length > 0
      ? mainProgressSections[mainProgressSections.length - 1]
      : undefined;
  if (mainDetailsBody) {
    mergedDetails.push(mainDetailsBody);
  }

  const childProgressSections: Array<{ label: string; section: ProgressSection }> = [];

  for (const child of childrenToMerge) {
    // Add child's title as a section header in details
    if (child.title || child.goal) {
      mergedDetails.push(`\n## ${child.title || child.goal}`);
    }

    // Add child's details
    if (child.details) {
      const { body, sections } = extractProgressSections(child.details);
      if (body?.trim()) {
        mergedDetails.push(body);
      }
      if (sections.length > 0) {
        const label = formatProgressSectionLabel(child);
        for (const section of sections) {
          childProgressSections.push({ label, section });
        }
      }
    }

    // Merge tasks
    if (child.tasks) {
      mergedTasks.push(...child.tasks);
    }
  }

  const mergedProgressSection = buildMergedProgressSection(
    mainProgressSection,
    childProgressSections
  );

  if (mergedProgressSection) {
    mergedDetails.push(mergedProgressSection);
  }

  // Update the main plan
  mainPlan.tasks = mergedTasks;
  if (mergedDetails.length > 0) {
    mainPlan.details = mergedDetails.join('\n\n');
  }
  // If the main plan was marked as an epic, clear it after merging
  if (mainPlan.epic) {
    mainPlan.epic = false;
  }

  // Prepare ID sets for pruning dependencies and grandchildren updates
  const childIds = new Set(childrenToMerge.map((c) => c.id).filter(Boolean));
  const childIdsNumbers = new Set<number>(Array.from(childIds) as number[]);
  const remainingPlanIds = new Set<number>(
    Array.from(plans.values())
      .map((p) => p.id)
      .filter((id): id is number => typeof id === 'number' && !childIdsNumbers.has(id))
  );

  // Add child dependencies to main plan, but only if they still exist after merge
  if (allChildDependencies.size > 0) {
    const existingDeps = new Set(mainPlan.dependencies || []);
    for (const dep of allChildDependencies) {
      if (remainingPlanIds.has(dep)) {
        existingDeps.add(dep);
      }
    }
    mainPlan.dependencies = Array.from(existingDeps).sort((a, b) => a - b);
  }

  // Also ensure main plan does not depend on any merged child plans
  if (mainPlan.dependencies && mainPlan.dependencies.length > 0) {
    mainPlan.dependencies = mainPlan.dependencies.filter((dep) => !childIdsNumbers.has(dep));
  }

  // Update the main plan's updatedAt timestamp
  mainPlan.updatedAt = new Date().toISOString();

  // Find grandchildren (children of the merged children) and update their parent
  const grandchildren = Array.from(plans.values()).filter(
    (plan) => plan.parent && childIds.has(plan.parent)
  );

  // Update grandchildren to point to the main plan
  for (const grandchild of grandchildren) {
    grandchild.parent = mainPlan.id;
    grandchild.updatedAt = new Date().toISOString();
    await writePlanFile(grandchild.filename, grandchild);
    log(`Updated parent of ${grandchild.title || `Plan ${grandchild.id}`} to main plan`);
  }

  // Prune dangling dependencies in all remaining plans (excluding the ones being deleted and main plan which we write below)
  for (const plan of plans.values()) {
    if ((plan.id && childIdsNumbers.has(plan.id)) || plan.filename === resolvedPlanFile) {
      continue;
    }
    if (plan.dependencies && plan.dependencies.length > 0) {
      const originalLen = plan.dependencies.length;
      plan.dependencies = plan.dependencies.filter((dep) => !childIdsNumbers.has(dep));
      if (plan.dependencies.length !== originalLen) {
        plan.updatedAt = new Date().toISOString();
        await writePlanFile(plan.filename, plan);
        log(
          `Removed ${originalLen - plan.dependencies.length} dangling dependenc(ies) from ${
            plan.title || `Plan ${plan.id}`
          }`
        );
      }
    }
  }

  // Save the updated main plan
  await writePlanFile(resolvedPlanFile, mainPlan);
  log(`Updated main plan: ${relative(gitRoot, resolvedPlanFile)}`);

  // Delete the merged child plan files
  for (const child of childrenToMerge) {
    try {
      await unlink(child.filename);
      log(`Deleted merged child plan: ${relative(gitRoot, child.filename)}`);
    } catch (err) {
      warn(`Failed to delete child plan file ${child.filename}: ${err as Error}`);
    }
  }

  log(
    `Successfully merged ${childrenToMerge.length} child plan(s) into ${mainPlan.title || `Plan ${mainPlan.id}`}`
  );
}
