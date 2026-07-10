import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';

import type { TimConfig } from './configSchema.js';
import { runMigrations } from './db/migrations.js';
import { getOrCreateProject, getProjectById } from './db/project.js';
import { writeProjectMetadata } from './project_metadata.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';

describe('writeProjectMetadata', () => {
  let db: Database;
  let projectId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    projectId = getOrCreateProject(db, 'github.com__example__repo', {
      uuid: PROJECT_UUID,
      remoteUrl: 'https://example.com/old.git',
      remoteLabel: 'old-label',
      lastGitRoot: '/old/root',
    }).id;
  });

  test('applies shared fields through project.upsert and keeps path fields out of the payload', async () => {
    const config = { sync: { disabled: true, nodeId: 'local-node' } } as TimConfig;

    await writeProjectMetadata(db, config, projectId, {
      remoteUrl: 'https://example.com/new.git',
      remoteLabel: 'new-label',
      lastGitRoot: '/new/root',
      externalConfigPath: '/new/root/.tim/config/tim.yml',
      externalTasksDir: '/new/root/tasks',
    });

    expect(getProjectById(db, projectId)).toMatchObject({
      remote_url: 'https://example.com/new.git',
      remote_label: 'new-label',
      last_git_root: '/new/root',
      external_config_path: '/new/root/.tim/config/tim.yml',
      external_tasks_dir: '/new/root/tasks',
    });
    const operation = db
      .prepare('SELECT operation_type, status, payload FROM sync_operation')
      .get() as { operation_type: string; status: string; payload: string };
    expect(operation).toMatchObject({ operation_type: 'project.upsert', status: 'applied' });
    expect(JSON.parse(operation.payload)).toEqual({
      type: 'project.upsert',
      projectUuid: PROJECT_UUID,
      repositoryId: 'github.com__example__repo',
      remoteUrl: 'https://example.com/new.git',
      remoteLabel: 'new-label',
      highestPlanId: 0,
    });
  });

  test('queues shared metadata on persistent nodes while updating local paths immediately', async () => {
    const config = {
      sync: {
        role: 'persistent',
        nodeId: 'persistent-node',
        mainUrl: 'https://main.example.com',
        nodeToken: 'secret',
      },
    } as TimConfig;

    await writeProjectMetadata(db, config, projectId, {
      remoteUrl: 'https://example.com/queued.git',
      lastGitRoot: '/persistent/root',
    });
    await writeProjectMetadata(db, config, projectId, {
      remoteUrl: 'https://example.com/queued.git',
      lastGitRoot: '/persistent/root',
    });

    expect(getProjectById(db, projectId)).toMatchObject({
      remote_url: 'https://example.com/old.git',
      last_git_root: '/persistent/root',
    });
    expect(db.prepare('SELECT operation_type, status FROM sync_operation').all()).toEqual([
      { operation_type: 'project.upsert', status: 'queued' },
    ]);
  });

  test('announces unchanged initial shared metadata on persistent nodes', async () => {
    const config = {
      sync: {
        role: 'persistent',
        nodeId: 'persistent-node',
        mainUrl: 'https://main.example.com',
        nodeToken: 'secret',
      },
    } as TimConfig;

    await writeProjectMetadata(db, config, projectId, {
      remoteUrl: 'https://example.com/old.git',
      remoteLabel: 'old-label',
      lastGitRoot: '/new/root',
    });

    expect(
      db.prepare('SELECT operation_type, status FROM sync_operation ORDER BY local_sequence').all()
    ).toEqual([{ operation_type: 'project.upsert', status: 'queued' }]);
    expect(getProjectById(db, projectId)?.last_git_root).toBe('/new/root');
  });

  test('does not deduplicate against an older queued value after metadata oscillates', async () => {
    const config = {
      sync: {
        role: 'persistent',
        nodeId: 'persistent-node',
        mainUrl: 'https://main.example.com',
        nodeToken: 'secret',
      },
    } as TimConfig;

    await writeProjectMetadata(db, config, projectId, { remoteLabel: 'value-a' });
    await writeProjectMetadata(db, config, projectId, { remoteLabel: 'value-b' });
    await writeProjectMetadata(db, config, projectId, { remoteLabel: 'value-a' });

    const queued = db
      .prepare(
        `SELECT payload FROM sync_operation
         WHERE operation_type = 'project.upsert'
         ORDER BY local_sequence`
      )
      .all() as Array<{ payload: string }>;
    expect(queued.map(({ payload }) => JSON.parse(payload).remoteLabel)).toEqual([
      'value-a',
      'value-b',
      'value-a',
    ]);
  });

  test('updates machine-local paths without creating a sync operation', async () => {
    const config = { sync: { role: 'main', nodeId: 'main-node' } } as TimConfig;

    await writeProjectMetadata(db, config, projectId, {
      lastGitRoot: '/local-only/root',
      externalTasksDir: '/local-only/tasks',
    });

    expect(getProjectById(db, projectId)).toMatchObject({
      last_git_root: '/local-only/root',
      external_tasks_dir: '/local-only/tasks',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM sync_operation').get()).toEqual({ count: 0 });
  });
});
