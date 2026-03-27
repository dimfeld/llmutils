import { unlink } from 'node:fs/promises';
import { relative, resolve as resolvePath } from 'node:path';
import { getGitRoot } from '../../common/git.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { removeAssignment } from '../db/assignment.js';
import { getDatabase } from '../db/database.js';
import { deletePlan, getPlanByPlanId, type PlanRow, upsertPlan } from '../db/plan.js';
import { toPlanUpsertInput } from '../db/plan_sync.js';
import { resolvePlanFromDbOrSyncFile } from '../ensure_plan_in_db.js';
import {
  getMaterializedPlanPath,
  resolveProjectContext,
  syncMaterializedPlan,
} from '../plan_materialize.js';
import { getLegacyAwareSearchDir } from '../path_resolver.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import { readPlanFile, resolvePlanFromDb, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { resolveWritablePath } from '../plans/resolve_writable_path.js';
import { ensureReferences } from '../utils/references.js';
import { loadPlansFromDb } from '../plans_db.js';
import { log, warn } from '../../logging.js';

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
  const repoRoot = await resolveRepoRootForPlanArg(planFile, gitRoot, globalOpts.config);
  await loadEffectiveConfig(globalOpts.config);
  const resolvedTasksDir = repoRoot;
  const repository = await getRepositoryIdentity({ cwd: repoRoot });
  let context = await resolveProjectContext(repoRoot, repository);
  await syncMaterializedPlans(repoRoot, context.rows);
  context = await resolveProjectContext(repoRoot, repository);

  const mainResolution = await resolvePlanFromDbOrSyncFile(planFile, repoRoot, repoRoot);
  const mainPlan = structuredClone(mainResolution.plan);

  if (!mainPlan.id) {
    throw new Error('Main plan must have an ID');
  }

  const { plans } = loadPlansFromDb(
    getLegacyAwareSearchDir(repository.gitRoot, repoRoot),
    repository.repositoryId
  );

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

      // If not found by ID, resolve the plan argument and ensure it is a direct child.
      if (!child) {
        const resolvedChild = await resolvePlanFromDbOrSyncFile(childArg, repoRoot, repoRoot).catch(
          () => null
        );
        if (resolvedChild?.plan.id) {
          child = allChildren.find((c) => c.id === resolvedChild.plan.id);
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
  const childIdsNumbers = new Set<number>(Array.from(childIds));
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

  const affectedPlans = new Map<number, PlanSchema>([[mainPlan.id, mainPlan]]);
  // Update grandchildren to point to the main plan.
  for (const grandchild of grandchildren) {
    if (!grandchild.id) {
      continue;
    }
    affectedPlans.set(grandchild.id, {
      ...grandchild,
      parent: mainPlan.id,
      updatedAt: new Date().toISOString(),
    });
  }

  // Prune dangling dependencies in all remaining plans (excluding the ones being deleted and main plan which we write below)
  for (const plan of plans.values()) {
    if ((plan.id && childIdsNumbers.has(plan.id)) || plan.id === mainPlan.id) {
      continue;
    }
    if (plan.dependencies && plan.dependencies.length > 0) {
      const originalLen = plan.dependencies.length;
      const nextDependencies = plan.dependencies.filter((dep) => !childIdsNumbers.has(dep));
      if (nextDependencies.length !== originalLen && plan.id) {
        affectedPlans.set(plan.id, {
          ...plan,
          dependencies: nextDependencies,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  const db = getDatabase();
  const idToUuid = new Map(context.planIdToUuid);
  const writeChanges = db.transaction(() => {
    for (const child of childrenToMerge) {
      if (!child.uuid) {
        continue;
      }
      deletePlan(db, child.uuid);
      removeAssignment(db, context.projectId, child.uuid);
    }

    for (const [planId, plan] of affectedPlans.entries()) {
      const row = getPlanByPlanId(db, context.projectId, planId);
      if (!row) {
        throw new Error(`Plan ${planId} not found`);
      }
      const { updatedPlan } = ensureReferences(plan, { planIdToUuid: idToUuid });
      upsertPlan(db, context.projectId, {
        ...toPlanUpsertInput(updatedPlan, row.filename, idToUuid),
        forceOverwrite: true,
      });
    }
  });
  writeChanges.immediate();

  const refreshedContext = await resolveProjectContext(repoRoot, repository);
  const plansToRewrite = new Set<number>([
    ...affectedPlans.keys(),
    ...refreshedContext.rows
      .map((row) => row.plan_id)
      .filter((planId) => !childIdsNumbers.has(planId)),
  ]);
  let updatedMainPath: string | null = mainResolution.planPath;
  for (const planId of plansToRewrite) {
    const refreshedPlan = (
      await resolvePlanFromDb(String(planId), repoRoot, {
        context: refreshedContext,
      })
    ).plan;
    const row = getPlanByPlanId(getDatabase(), refreshedContext.projectId, planId);
    const candidatePaths = new Set<string>();
    if (planId === mainPlan.id && mainResolution.planPath) {
      candidatePaths.add(mainResolution.planPath);
    }
    const legacyPath = plans.get(planId)?.filename;
    if (legacyPath) {
      candidatePaths.add(legacyPath);
    }
    if (row) {
      const fallbackPath = await resolveWritablePath(
        String(planId),
        row,
        resolvedTasksDir,
        repoRoot
      );
      if (fallbackPath) {
        candidatePaths.add(fallbackPath);
      }
    }

    for (const outputPath of candidatePaths) {
      const exists = await Bun.file(outputPath)
        .stat()
        .then((stats) => stats.isFile())
        .catch(() => false);
      if (!exists) {
        continue;
      }

      const planForFile = structuredClone(refreshedPlan);
      const existingFile = await readPlanFile(outputPath);
      if (planId === mainPlan.id) {
        const preservedDependencies = (existingFile.dependencies ?? []).filter(
          (dep) => !childIdsNumbers.has(dep)
        );
        planForFile.dependencies = [
          ...new Set([...(planForFile.dependencies ?? []), ...preservedDependencies]),
        ];
      }
      if (planForFile.dependencies && planForFile.dependencies.length > 1) {
        planForFile.dependencies = [...planForFile.dependencies].sort((a, b) => a - b);
      }
      await writePlanFile(outputPath, planForFile, {
        cwdForIdentity: repoRoot,
        context: refreshedContext,
        skipDb: true,
        skipUpdatedAt: true,
      });
      if (planId === mainPlan.id) {
        updatedMainPath = outputPath;
      }
    }
  }

  if (updatedMainPath) {
    log(`Updated main plan: ${relative(gitRoot, updatedMainPath)}`);
  }

  // Delete the merged child plan files
  for (const child of childrenToMerge) {
    const targetPaths = [child.filename, getMaterializedPlanPath(repoRoot, child.id ?? 0)].filter(
      (filePath, index, all) => Boolean(filePath) && all.indexOf(filePath) === index
    );
    for (const targetPath of targetPaths) {
      try {
        await unlink(targetPath);
        log(`Deleted merged child plan: ${relative(gitRoot, targetPath)}`);
      } catch (err) {
        const isMissing =
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as NodeJS.ErrnoException).code === 'ENOENT';
        if (!isMissing) {
          warn(`Failed to delete child plan file ${targetPath}: ${err as Error}`);
        }
      }
    }
  }

  log(
    `Successfully merged ${childrenToMerge.length} child plan(s) into ${mainPlan.title || `Plan ${mainPlan.id}`}`
  );
}

async function syncMaterializedPlans(repoRoot: string, rows: PlanRow[]): Promise<void> {
  for (const row of rows) {
    const materializedPath = getMaterializedPlanPath(repoRoot, row.plan_id);
    const exists = await Bun.file(materializedPath)
      .stat()
      .then((stats) => stats.isFile())
      .catch(() => false);
    if (exists) {
      await syncMaterializedPlan(row.plan_id, repoRoot);
    }
  }
}
