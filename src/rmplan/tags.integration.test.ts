import { describe, test, beforeEach, afterEach, expect, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../testing.js';
import { handleAddCommand } from './commands/add.js';
import { handleSetCommand } from './commands/set.js';
import { mcpListReadyPlans } from './commands/ready.js';
import { getDefaultConfig, type RmplanConfig } from './configSchema.js';
import type { GenerateModeRegistrationContext } from './mcp/generate_mode.js';
import { mcpCreatePlan } from './mcp/generate_mode.js';
import { clearPlanCache, readPlanFile } from './plans.js';

describe('tag workflows across CLI and MCP', () => {
  let tempDir: string;
  let tasksDir: string;
  let command: any;
  let moduleMocker: ModuleMocker;
  let logSpy: ReturnType<typeof mock>;
  let warnSpy: ReturnType<typeof mock>;
  let mockConfig: RmplanConfig;
  let mcpContext: GenerateModeRegistrationContext;

  beforeEach(async () => {
    clearPlanCache();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-tag-flow-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    moduleMocker = new ModuleMocker(import.meta);
    logSpy = mock(() => {});
    warnSpy = mock(() => {});

    await moduleMocker.mock('../logging.js', () => ({
      log: (...args: unknown[]) => logSpy(...args),
      warn: (...args: unknown[]) => warnSpy(...args),
      error: mock(() => {}),
    }));

    await moduleMocker.mock('./configLoader.js', () => ({
      loadEffectiveConfig: async () => mockConfig,
    }));

    await moduleMocker.mock('../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));

    await moduleMocker.mock('./assignments/assignments_io.js', () => ({
      readAssignments: async () => ({
        repositoryId: 'test-repo',
        repositoryRemoteUrl: null,
        version: 0,
        assignments: {},
      }),
      removeAssignment: async () => {},
      AssignmentsFileParseError: class extends Error {},
    }));

    await moduleMocker.mock('./assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId: 'test-repo',
        repositoryRemoteUrl: null,
      }),
    }));

    await moduleMocker.mock('../common/clipboard.js', () => ({
      copy: async () => {},
      isEnabled: () => false,
    }));

    command = {
      parent: {
        opts: () => ({
          config: path.join(tempDir, 'rmplan.yml'),
        }),
      },
    };

    mockConfig = getDefaultConfig();
    mockConfig.paths = { tasks: tasksDir };

    mcpContext = {
      config: mockConfig,
      configPath: undefined,
      gitRoot: tempDir,
    };
  });

  afterEach(async () => {
    moduleMocker.clear();
    clearPlanCache();
    await fs.rm(tempDir, { recursive: true, force: true });
    logSpy.mockReset();
    warnSpy.mockReset();
  });

  test('cli-created tags appear in MCP list-ready filters', async () => {
    await handleAddCommand(['Frontend', 'Feature'], { tag: ['Frontend', 'ops'] }, command);
    await handleAddCommand(['Backend', 'Cleanup'], { tag: ['backend'] }, command);

    const filteredJson = await mcpListReadyPlans({ tags: ['OPS'] }, mcpContext);
    const filtered = JSON.parse(filteredJson);
    expect(filtered.count).toBe(1);
    expect(filtered.plans[0].title).toContain('Frontend');
    expect(filtered.plans[0].tags).toEqual(['frontend', 'ops']);

    const missingJson = await mcpListReadyPlans({ tags: ['design'] }, mcpContext);
    const missing = JSON.parse(missingJson);
    expect(missing.count).toBe(0);
  });

  test('MCP-created tags can be updated through CLI set command', async () => {
    await mcpCreatePlan(
      {
        title: 'MCP-origin plan',
        tags: ['Frontend'],
      },
      mcpContext
    );

    const planFiles = await fs.readdir(tasksDir);
    expect(planFiles).toHaveLength(1);
    const planPath = path.join(tasksDir, planFiles[0]);

    await handleSetCommand(
      planPath,
      {
        tag: ['OPS'],
        noTag: ['frontend'],
      },
      command.parent.opts()
    );

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.tags).toEqual(['ops']);

    const filteredJson = await mcpListReadyPlans({ tags: ['ops'] }, mcpContext);
    const filtered = JSON.parse(filteredJson);
    expect(filtered.count).toBe(1);
    expect(filtered.plans[0].tags).toEqual(['ops']);
  });

  test('tag allowlist validation stays in sync between CLI and MCP interfaces', async () => {
    mockConfig.tags = { allowed: ['frontend'] };

    await handleAddCommand(['Allowlisted', 'Plan'], { tag: ['Frontend'] }, command);
    const planFiles = await fs.readdir(tasksDir);
    const planPath = path.join(tasksDir, planFiles[0]);

    await expect(
      handleSetCommand(
        planPath,
        {
          tag: ['backend'],
        },
        command.parent.opts()
      )
    ).rejects.toThrow('Invalid tag');

    await expect(
      mcpCreatePlan(
        {
          title: 'Disallowed MCP Plan',
          tags: ['backend'],
        },
        mcpContext
      )
    ).rejects.toThrow('Invalid tag');

    const planAfterFailure = await readPlanFile(planPath);
    expect(planAfterFailure.tags).toEqual(['frontend']);
  });
});
