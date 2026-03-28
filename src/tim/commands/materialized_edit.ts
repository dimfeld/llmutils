import { readFile, rm } from 'node:fs/promises';
import { warn } from '../../logging.js';
import { logSpawn } from '../../common/process.js';
import {
  getMaterializedPlanPath,
  getShadowPlanPath,
  materializePlan,
  syncMaterializedPlan,
} from '../plan_materialize.js';
import { readPlanFile, writePlanFile } from '../plans.js';

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

  const editorProcess = logSpawn([selectedEditor, materializedPath], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  await editorProcess.exited;
  if (typeof editorProcess.exitCode === 'number' && editorProcess.exitCode !== 0) {
    throw new Error(`Editor exited with code ${editorProcess.exitCode ?? 'unknown'}`);
  }

  let shouldDeleteMaterializedFile = !existedBeforeEdit;
  try {
    const afterEditContent = await readFile(materializedPath, 'utf-8');
    if (afterEditContent !== beforeEditContent) {
      const editedPlan = await readPlanFile(materializedPath);
      if (editedPlan.updatedAt === beforeEditUpdatedAt) {
        editedPlan.updatedAt = new Date().toISOString();
        await writePlanFile(materializedPath, editedPlan, {
          skipDb: true,
          skipUpdatedAt: true,
        });
      }

      await syncMaterializedPlan(planId, repoRoot);
    }
    if (shouldDeleteMaterializedFile) {
      await rm(materializedPath, { force: true });
      await rm(getShadowPlanPath(repoRoot, planId), { force: true });
    }
  } catch (error) {
    shouldDeleteMaterializedFile = false;
    warn(`Failed to sync edited plan ${planId}. Edited file kept at ${materializedPath}`);
    throw error;
  }
}
