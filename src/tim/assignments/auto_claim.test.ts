import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';
import { closeDatabaseForTesting } from '../db/database.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('autoClaimPlan', () => {
  let tempRoot: string;
  let configDir: string;
  let repoDir: string;
  let originalEnv: Partial<Record<string, string>>;

  let enableAutoClaim: typeof import('./auto_claim.js').enableAutoClaim;
  let disableAutoClaim: typeof import('./auto_claim.js').disableAutoClaim;
  let autoClaimPlan: typeof import('./auto_claim.js').autoClaimPlan;
  let isAutoClaimEnabled: typeof import('./auto_claim.js').isAutoClaimEnabled;

  const repositoryId = 'auto-claim-repo';
  const userName = 'integration-user';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-claim-test-'));
    configDir = path.join(tempRoot, 'config');
    repoDir = path.join(tempRoot, 'workspace');

    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(repoDir, { recursive: true });

    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };

    process.env.XDG_CONFIG_HOME = configDir;
    delete process.env.APPDATA;

    await moduleMocker.mock('./workspace_identifier.ts', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId,
        remoteUrl: 'https://example.com/demo.git',
        gitRoot: repoDir,
      }),
      getUserIdentity: () => userName,
    }));

    ({ enableAutoClaim, disableAutoClaim, autoClaimPlan, isAutoClaimEnabled } =
      await import('./auto_claim.js'));

    disableAutoClaim();
  });

  afterEach(async () => {
    moduleMocker.clear();
    closeDatabaseForTesting();

    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }

    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('does nothing when auto-claim is disabled', async () => {
    const result = await autoClaimPlan(
      {
        plan: {
          id: 7,
          uuid: '00000000-0000-4000-8000-000000000007',
          title: 'Disabled plan',
          goal: '',
          details: '',
          status: 'pending',
          tasks: [],
          filename: path.join(repoDir, 'tasks', '7-disabled.plan.md'),
        },
        uuid: '00000000-0000-4000-8000-000000000007',
      },
      { cwdForIdentity: repoDir }
    );

    expect(result).toBeNull();
    expect(isAutoClaimEnabled()).toBe(false);
  });

  test('persists assignment when enabled', async () => {
    enableAutoClaim();
    expect(isAutoClaimEnabled()).toBe(true);

    const uuid = '11111111-2222-4333-8444-555555555555';
    const planPath = path.join(repoDir, 'tasks', '1-plan.plan.md');

    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, '# Placeholder plan\n');

    const result = await autoClaimPlan(
      {
        plan: {
          id: 1,
          uuid,
          title: 'Auto-claim demo',
          goal: '',
          details: '',
          status: 'pending',
          tasks: [],
          filename: planPath,
        },
        uuid,
      },
      { cwdForIdentity: repoDir }
    );

    expect(result).not.toBeNull();
    expect(result?.user).toBe(userName);
    expect(result?.result.persisted).toBe(true);
    expect(result?.result.entry.planId).toBe(1);
    expect(result?.result.entry.users).toEqual([userName]);
    expect(result?.result.entry.workspacePaths).toEqual([repoDir]);

    disableAutoClaim();
    expect(isAutoClaimEnabled()).toBe(false);
  });
});
