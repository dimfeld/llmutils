import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildWorkspaceCommandEnv } from './env.js';

describe('buildWorkspaceCommandEnv', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-env-helper-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('preserves existing precedence when project environment options are absent', async () => {
    await fs.writeFile(path.join(tempDir, '.env'), 'TIM_SHARED=from-dotenv\n');

    const env = await buildWorkspaceCommandEnv(
      tempDir,
      { TIM_EXPLICIT: 'from-explicit' },
      {
        inheritedEnv: {
          TIM_SHARED: 'from-inherited',
          TIM_INHERITED: 'present',
          PATH: '/bin:/tmp/bun-node-shim',
        },
      }
    );

    expect(env.TIM_SHARED).toBe('from-dotenv');
    expect(env.TIM_INHERITED).toBe('present');
    expect(env.TIM_EXPLICIT).toBe('from-explicit');
    expect(env.PATH).toBe('/bin');
  });

  test('composes project env, dotenv, override-dotenv entries, built-ins, and explicit overrides', async () => {
    await fs.writeFile(
      path.join(tempDir, '.env'),
      [
        'TIM_NORMAL=from-dotenv',
        'TIM_OVERRIDE=from-dotenv',
        'TIM_PLAN_ID=from-dotenv',
        'TIM_EXPLICIT=from-dotenv',
      ].join('\n')
    );

    const env = await buildWorkspaceCommandEnv(
      tempDir,
      {
        TIM_EXPLICIT: 'from-explicit',
        TIM_PLAN_ID: 'explicit-plan',
      },
      {
        inheritedEnv: {
          DATABASE_NAME: 'from-inherited',
          TIM_NORMAL: 'from-inherited',
          TIM_OVERRIDE: 'from-inherited',
          TIM_PLAN_ID: 'from-inherited',
          PATH: '/usr/bin',
        },
        timEnvironment: {
          environment: {
            DATABASE_NAME: 'database-{{ planId }}',
            TIM_NORMAL: 'normal-{{ planId }}',
            TIM_OVERRIDE: {
              value: 'override-{{ workspaceId ?? planId }}',
              precedence: 'override-dotenv',
            },
          },
          context: {
            workspaceId: 'task-373',
            planId: '373',
            branch: 'tim/373-project-env',
          },
        },
      }
    );

    expect(env.DATABASE_NAME).toBe('database-373');
    expect(env.TIM_NORMAL).toBe('from-dotenv');
    expect(env.TIM_OVERRIDE).toBe('override-task-373');
    expect(env.TIM_BRANCH).toBe('tim/373-project-env');
    expect(env.TIM_EXPLICIT).toBe('from-explicit');
    expect(env.TIM_PLAN_ID).toBe('explicit-plan');
  });

  test('normal project environment overrides inherited env when dotenv is absent', async () => {
    const env = await buildWorkspaceCommandEnv(tempDir, undefined, {
      inheritedEnv: {
        TIM_NORMAL: 'from-inherited',
        PATH: '/usr/bin:/tmp/bun-node-shim',
      },
      timEnvironment: {
        environment: {
          TIM_NORMAL: 'normal-{{ planId }}',
        },
        context: {
          planId: '373',
        },
      },
    });

    expect(env.TIM_NORMAL).toBe('normal-373');
    expect(env.PATH).toBe('/usr/bin');
  });

  test('reserved built-ins override inherited env and dotenv when not explicitly overridden', async () => {
    await fs.writeFile(path.join(tempDir, '.env'), 'TIM_PLAN_ID=from-dotenv\n');

    const env = await buildWorkspaceCommandEnv(tempDir, undefined, {
      inheritedEnv: {
        TIM_PLAN_ID: 'from-inherited',
      },
      timEnvironment: {
        context: {
          planId: '373',
        },
      },
    });

    expect(env.TIM_PLAN_ID).toBe('373');
  });
});
