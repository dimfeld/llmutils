import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepositoryIdentity } from '../../assignments/workspace_identifier.js';
import { closeDatabaseForTesting, getDatabase } from '../../db/database.js';
import { getOrCreateProject } from '../../db/project.js';
import {
  upsertCanonicalPlanInTransaction,
  upsertProjectionPlanInTransaction,
} from '../../db/plan.js';
import { runWithLogger } from '../../../logging.js';
import { ConsoleAdapter } from '../../../logging/console.js';

export interface ArtifactCommandTestContext {
  tempDir: string;
  sourceDir: string;
  db: Database;
  projectUuid: string;
  restore: () => Promise<void>;
}

export async function setupArtifactCommandTest(): Promise<ArtifactCommandTestContext> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-artifact-command-test-'));
  const sourceDir = path.join(tempDir, 'source');
  await fs.mkdir(sourceDir, { recursive: true });
  const originalCwd = process.cwd();
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
  process.env.XDG_DATA_HOME = path.join(tempDir, 'data');
  process.chdir(tempDir);
  closeDatabaseForTesting();
  const db = getDatabase();
  const repository = await getRepositoryIdentity({ cwd: tempDir });
  const project = getOrCreateProject(db, repository.repositoryId, {
    remoteUrl: repository.remoteUrl,
    lastGitRoot: tempDir,
  });
  const plan = {
    uuid: '22222222-2222-4222-8222-222222222222',
    planId: 1,
    title: 'Artifact command plan',
    status: 'pending' as const,
    revision: 1,
    forceOverwrite: true,
  };
  upsertCanonicalPlanInTransaction(db, project.id, plan);
  upsertProjectionPlanInTransaction(db, project.id, plan);

  return {
    tempDir,
    sourceDir,
    db,
    projectUuid: project.uuid,
    restore: async () => {
      closeDatabaseForTesting();
      process.chdir(originalCwd);
      if (originalXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
      }
      if (originalXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = originalXdgDataHome;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

export async function runWithConsoleLogger<T>(callback: () => Promise<T>): Promise<T> {
  return runWithLogger(new ConsoleAdapter(), callback);
}
