import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAllTimCaches } from '../../testing.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { type TimConfig, getDefaultConfig } from '../configSchema.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getPlanByPlanId, nonSyncedUpsertPlan } from '../db/plan.js';
import { getOrCreateProject } from '../db/project.js';
import { materializePlan } from '../plan_materialize.js';
import { readPlanFile, writePlanFile } from '../plans.js';
import { updatePlanDetailsTool } from './update_plan_details.js';

describe('tool plan write configuration', () => {
  let tempDir: string;
  let repoDir: string;
  let originalXdgConfigHome: string | undefined;
  let originalGitConfigGlobal: string | undefined;
  let originalTimLoadGlobalConfig: string | undefined;

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-tool-plan-write-config-'));
    repoDir = path.join(tempDir, 'repo');
    await fs.mkdir(repoDir, { recursive: true });

    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    originalTimLoadGlobalConfig = process.env.TIM_LOAD_GLOBAL_CONFIG;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg');
    process.env.GIT_CONFIG_GLOBAL = path.join(tempDir, 'gitconfig-global');
    process.env.TIM_LOAD_GLOBAL_CONFIG = '1';
    await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, '', 'utf8');

    await Bun.$`git init`.cwd(repoDir).quiet();
    await Bun.$`git remote add origin https://example.com/acme/tool-plan-write-config.git`
      .cwd(repoDir)
      .quiet();
  });

  afterEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();

    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    if (originalGitConfigGlobal === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
    }
    if (originalTimLoadGlobalConfig === undefined) {
      delete process.env.TIM_LOAD_GLOBAL_CONFIG;
    } else {
      process.env.TIM_LOAD_GLOBAL_CONFIG = originalTimLoadGlobalConfig;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('persistent tool config queues both materialized pre-sync and tool writes', async () => {
    const repository = await getRepositoryIdentity({ cwd: repoDir });
    const db = getDatabase();
    const project = getOrCreateProject(db, repository.repositoryId, {
      remoteUrl: repository.remoteUrl,
      lastGitRoot: repository.gitRoot,
    });
    const planUuid = '11111111-1111-4111-8111-111111111111';
    nonSyncedUpsertPlan(db, project.id, {
      uuid: planUuid,
      planId: 1,
      title: 'Canonical title',
      goal: 'Test tool config propagation',
      details: 'Canonical details',
      status: 'pending',
      tasks: [],
    });

    const planPath = await materializePlan(1, repoDir);
    const materializedPlan = await readPlanFile(planPath);
    materializedPlan.title = 'Title edited in materialized file';
    await writePlanFile(planPath, materializedPlan, {
      skipDb: true,
      skipUpdatedAt: true,
    });

    const persistentConfig: TimConfig = {
      ...getDefaultConfig(),
      sync: {
        role: 'persistent',
        nodeId: 'persistent-tool-node',
        mainUrl: 'http://127.0.0.1:29999',
        nodeToken: 'secret',
        offline: true,
      },
    };

    await updatePlanDetailsTool(
      {
        plan: 1,
        details: 'Details written by the tool',
        append: false,
      },
      { config: persistentConfig, gitRoot: repoDir }
    );

    const operations = db
      .prepare(
        `SELECT operation_type, status, payload
         FROM sync_operation
         WHERE operation_type != 'project.upsert'
         ORDER BY local_sequence`
      )
      .all() as Array<{ operation_type: string; status: string; payload: string }>;
    expect(operations.map((operation) => [operation.operation_type, operation.status])).toEqual([
      ['plan.patch_text', 'queued'],
      ['plan.patch_text', 'queued'],
    ]);
    expect(operations.map((operation) => JSON.parse(operation.payload).field)).toEqual([
      'title',
      'details',
    ]);

    const projection = getPlanByPlanId(db, project.id, 1);
    expect(projection?.title).toBe('Title edited in materialized file');
    expect(projection?.details).toContain('Details written by the tool');

    const canonical = db
      .prepare('SELECT title, details FROM plan_canonical WHERE uuid = ?')
      .get(planUuid) as { title: string; details: string };
    expect(canonical).toEqual({
      title: 'Canonical title',
      details: 'Canonical details',
    });
  });
});
