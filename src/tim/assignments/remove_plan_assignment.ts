import { warn } from '../../logging.js';
import { removeAssignment } from '../db/assignment.js';
import { getDatabase } from '../db/database.js';
import { getProject } from '../db/project.js';
import type { PlanSchema } from '../planSchema.js';
import { getRepositoryIdentity } from './workspace_identifier.js';

export async function removePlanAssignment(plan: PlanSchema, baseDir?: string): Promise<void> {
  if (!plan.uuid) {
    return;
  }

  try {
    const repository = await getRepositoryIdentity({ cwd: baseDir });
    const db = getDatabase();
    const project = getProject(db, repository.repositoryId);
    if (!project) {
      return;
    }

    removeAssignment(db, project.id, plan.uuid);
  } catch (error) {
    const planLabel = plan.id !== undefined ? `plan ${plan.id}` : `plan ${plan.uuid}`;
    warn(
      `Failed to remove assignment for ${planLabel}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
