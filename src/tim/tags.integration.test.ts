import { describe, test, beforeEach, afterEach, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleAddCommand } from './commands/add.js';
import { handleSetCommand } from './commands/set.js';
import { mcpListReadyPlans } from './commands/ready.js';
import { getDefaultConfig, type TimConfig } from './configSchema.js';
import type { GenerateModeRegistrationContext } from './mcp/generate_mode.js';
import { mcpCreatePlan } from './mcp/generate_mode.js';
import { resolvePlanByNumericId } from './plans.js';

// Mock the modules that were previously mocked by ModuleMocker
const { logSpy, warnSpy } = vi.hoisted(() => ({
  logSpy: vi.fn(() => {}),
  warnSpy: vi.fn(() => {}),
}));

vi.mock('../logging.js', () => ({
  log: logSpy,
  warn: warnSpy,
  error: vi.fn(() => {}),
}));

vi.mock('./configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../common/git.js', () => ({
  getGitRoot: vi.fn(),
}));

vi.mock('./assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(),
}));

vi.mock('../common/clipboard.js', () => ({
  copy: vi.fn(),
  isEnabled: vi.fn(() => false),
}));

// Import mocked modules for setup
import { loadEffectiveConfig } from './configLoader.js';
import { getGitRoot } from '../common/git.js';
import { getRepositoryIdentity } from './assignments/workspace_identifier.js';

describe('tag workflows across CLI and MCP', () => {
  let tempDir: string;
  let tasksDir: string;
  let command: any;
  let mockConfig: TimConfig;
  let mcpContext: GenerateModeRegistrationContext;

  // Helper to get typed mocks
  const mockLoadEffectiveConfig = loadEffectiveConfig as ReturnType<typeof vi.fn>;
  const mockGetGitRoot = getGitRoot as ReturnType<typeof vi.fn>;
  const mockGetRepositoryIdentity = getRepositoryIdentity as ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-tag-flow-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Reset mocks
    logSpy.mockClear();
    warnSpy.mockClear();

    // Set up mock implementations
    mockConfig = getDefaultConfig();
    mockConfig.paths = { tasks: tasksDir };
    mockLoadEffectiveConfig.mockResolvedValue(mockConfig);
    mockGetGitRoot.mockResolvedValue(tempDir);
    mockGetRepositoryIdentity.mockResolvedValue({
      repositoryId: `test-repo-${path.basename(tempDir)}`,
      remoteUrl: null,
      gitRoot: tempDir,
    });

    command = {
      parent: {
        opts: () => ({
          config: path.join(tempDir, 'tim.yml'),
        }),
      },
    };

    mcpContext = {
      config: mockConfig,
      configPath: undefined,
      gitRoot: tempDir,
    };
  });

  afterEach(async () => {
    vi.clearAllMocks();
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
    const result = await mcpCreatePlan(
      {
        title: 'MCP-origin plan',
        tags: ['Frontend'],
      },
      mcpContext
    );
    const createdId = Number(result.match(/Created plan (\d+)/)?.[1]);

    await handleSetCommand(
      createdId,
      {
        tag: ['OPS'],
        noTag: ['frontend'],
      },
      command.parent.opts()
    );

    expect(createdId).toBeGreaterThan(0);

    const { plan: updatedPlan } = await resolvePlanByNumericId(createdId, tempDir);
    expect(updatedPlan.tags).toEqual(['ops']);

    const filteredJson = await mcpListReadyPlans({ tags: ['ops'] }, mcpContext);
    const filtered = JSON.parse(filteredJson);
    expect(filtered.count).toBe(1);
    expect(filtered.plans[0].tags).toEqual(['ops']);
  });

  test('tag allowlist validation stays in sync between CLI and MCP interfaces', async () => {
    mockConfig.tags = { allowed: ['frontend'] };

    await handleAddCommand(['Allowlisted', 'Plan'], { tag: ['Frontend'] }, command);

    await expect(
      handleSetCommand(
        1,
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

    const { plan: planAfterFailure } = await resolvePlanByNumericId(1, tempDir);
    expect(planAfterFailure.tags).toEqual(['frontend']);
  });
});
