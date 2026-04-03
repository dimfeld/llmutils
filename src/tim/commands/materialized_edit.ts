import chalk from 'chalk';
import { readFile, rm } from 'node:fs/promises';
import { promptConfirm } from '../../common/input.js';
import { logSpawn } from '../../common/process.js';
import { error, warn } from '../../logging.js';
import {
  getMaterializedPlanPath,
  getShadowPlanPath,
  materializePlan,
  syncMaterializedPlan,
} from '../plan_materialize.js';
import { NoFrontmatterError, readPlanFile } from '../plans.js';

async function openEditor(materializedPath: string, selectedEditor: string): Promise<void> {
  const editorProcess = logSpawn([selectedEditor, materializedPath], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  await editorProcess.exited;
  if (typeof editorProcess.exitCode === 'number' && editorProcess.exitCode !== 0) {
    throw new Error(`Editor exited with code ${editorProcess.exitCode}`);
  }
}

export function isUserFixableParseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error instanceof NoFrontmatterError) {
    return true;
  }

  return (
    error.name === 'PlanFileError' ||
    error.name === 'YAMLParseError' ||
    error.name === 'YAMLSemanticError' ||
    error.name === 'YAMLSyntaxError' ||
    (error instanceof ReferenceError && /alias|anchor/i.test(error.message))
  );
}

export async function editMaterializedPlan(
  planId: number,
  repoRoot: string,
  editor?: string
): Promise<void> {
  const materializedPath = getMaterializedPlanPath(repoRoot, planId);
  const existedBeforeEdit = await Bun.file(materializedPath)
    .stat()
    .then((stats) => stats.isFile())
    .catch(() => false);
  await materializePlan(planId, repoRoot);
  const selectedEditor = editor || process.env.EDITOR || 'nano';
  const beforeEditPlan = await readPlanFile(materializedPath);
  const beforeEditUpdatedAt = beforeEditPlan.updatedAt;
  const beforeEditContent = await readFile(materializedPath, 'utf-8');

  let shouldDeleteMaterializedFile = !existedBeforeEdit;
  try {
    while (true) {
      await openEditor(materializedPath, selectedEditor);

      const afterEditContent = await readFile(materializedPath, 'utf-8');
      if (afterEditContent === beforeEditContent) {
        break;
      }

      let editedPlan;
      try {
        editedPlan = await readPlanFile(materializedPath);
      } catch (parseError) {
        // Only offer re-edit for parse errors (bad YAML, missing frontmatter,
        // schema validation). I/O errors should propagate immediately.
        if (!isUserFixableParseError(parseError)) {
          throw parseError;
        }

        error(chalk.red(`Failed to parse edited plan ${planId}:`));
        error(chalk.red((parseError as Error).message));

        let shouldReEdit = false;
        try {
          shouldReEdit = await promptConfirm({
            message: 'Would you like to edit the file again to fix these issues?',
            default: true,
          });
        } catch {
          // Any prompt failure (cancellation, timeout, non-TTY, transport error)
          // is treated as decline — preserve the file and surface the parse error.
        }

        if (!shouldReEdit) {
          shouldDeleteMaterializedFile = false;
          throw parseError;
        }
        continue;
      }

      const editorChangedUpdatedAt = editedPlan.updatedAt !== beforeEditUpdatedAt;

      await syncMaterializedPlan(planId, repoRoot, {
        force: false,
        skipRematerialize: true,
        context: undefined,
        preserveUpdatedAt: editorChangedUpdatedAt ? editedPlan.updatedAt : undefined,
      });
      break;
    }

    if (shouldDeleteMaterializedFile) {
      await rm(materializedPath, { force: true });
      await rm(getShadowPlanPath(repoRoot, planId), { force: true });
    }
  } catch (error) {
    shouldDeleteMaterializedFile = false;
    warn(`Failed to process edited plan ${planId}. Edited file kept at ${materializedPath}`);
    throw error;
  }
}
