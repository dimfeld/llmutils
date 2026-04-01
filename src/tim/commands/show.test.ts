import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import stripAnsi from 'strip-ansi';
import { handleShowCommand, mcpGetPlan } from './show.js';
import type { GenerateModeRegistrationContext } from '../mcp/generate_mode.js';

// Mock console functions
let logSpy: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.fn>;
const fakeDb = {
  transaction<T>(fn: () => T) {
    return fn;
  },
};

// Mock modules before imports
vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getCurrentBranchName: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn().mockResolvedValue({
    paths: {
      tasks: '',
    },
  }),
}));

vi.mock('../assignments/workspace_identifier.ts', () => ({
  getRepositoryIdentity: vi.fn().mockResolvedValue({
    repositoryId: '',
    remoteUrl: 'https://example.com/repo.git',
    gitRoot: '',
  }),
}));

vi.mock('../db/database.js', () => ({
  getDatabase: vi.fn().mockReturnValue({} as any),
}));

vi.mock('../db/project.js', () => ({
  getProject: vi.fn().mockReturnValue({ id: 1 }),
  getOrCreateProject: vi.fn().mockReturnValue({ id: 1 }),
}));

vi.mock('../plans_db.js', () => ({
  loadPlansFromDb: vi.fn().mockReturnValue({ plans: new Map(), duplicates: {} }),
}));

vi.mock('../plan_display.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolvePlan: vi.fn(),
  };
});

vi.mock('../db/assignment.js', () => ({
  getAssignmentEntriesByProject: vi.fn().mockReturnValue({}),
}));

// Now import the module being tested
import { log, error, warn } from '../../logging.js';
import { getCurrentBranchName, getGitRoot } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { getDatabase } from '../db/database.js';
import { getProject, getOrCreateProject } from '../db/project.js';
import { loadPlansFromDb } from '../plans_db.js';
import { resolvePlan } from '../plan_display.js';
import { getAssignmentEntriesByProject } from '../db/assignment.js';

describe('handleShowCommand', () => {
  let tempDir: string;
  let repoDir: string;
  let tasksDir: string;
  let repositoryId: string;
  let assignmentsData: Record<string, any>;
  let dbPlans: any[];
  let dbPlanTasks: any[];
  let dbPlanDependencies: any[];
  let dbPlanTags: any[];
  let currentBranchName: string | null;

  beforeEach(async () => {
    // Get properly typed mock instances
    logSpy = vi.mocked(log);
    errorSpy = vi.mocked(error);
    warnSpy = vi.mocked(warn);

    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-show-test-'));
    repoDir = path.join(tempDir, 'repo');
    tasksDir = path.join(repoDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    repositoryId = 'show-tests';
    assignmentsData = {};
    dbPlans = [];
    dbPlanTasks = [];
    dbPlanDependencies = [];
    dbPlanTags = [];
    currentBranchName = null;

    // Set up mock implementations
    const mockGetCurrentBranchName = vi.mocked(getCurrentBranchName);
    mockGetCurrentBranchName.mockImplementation(async () => currentBranchName);

    const mockLoadEffectiveConfig = vi.mocked(loadEffectiveConfig);
    mockLoadEffectiveConfig.mockResolvedValue({
      paths: {
        tasks: tasksDir,
      },
    });

    const mockGetRepositoryIdentity = vi.mocked(getRepositoryIdentity);
    mockGetRepositoryIdentity.mockResolvedValue({
      repositoryId,
      remoteUrl: 'https://example.com/repo.git',
      gitRoot: repoDir,
    });

    const mockGetDatabase = vi.mocked(getDatabase);
    mockGetDatabase.mockReturnValue(fakeDb as any);

    const mockGetProject = vi.mocked(getProject);
    mockGetProject.mockReturnValue({ id: 1 });

    const mockGetOrCreateProject = vi.mocked(getOrCreateProject);
    mockGetOrCreateProject.mockReturnValue({ id: 1 });

    const mockLoadPlansFromDb = vi.mocked(loadPlansFromDb);
    mockLoadPlansFromDb.mockImplementation(() => {
      const plans = new Map();
      for (const plan of dbPlans) {
        plans.set(plan.id, plan);
      }
      return { plans, duplicates: {} } as any;
    });

    const mockResolvePlan = vi.mocked(resolvePlan);
    mockResolvePlan.mockImplementation(async (planArg: string, _context: any) => {
      const parsedId = Number.parseInt(String(planArg), 10);
      const rawPlan = dbPlans.find(
        (candidate) => candidate.id === parsedId || candidate.plan_id === parsedId
      );
      const plan =
        rawPlan && 'plan_id' in rawPlan
          ? {
              id: rawPlan.plan_id,
              uuid: rawPlan.uuid,
              title: rawPlan.title ?? undefined,
              goal: rawPlan.goal ?? '',
              details: rawPlan.details ?? '',
              status: rawPlan.status ?? 'pending',
              priority: rawPlan.priority ?? undefined,
              epic: Boolean(rawPlan.epic),
              simple: Boolean(rawPlan.simple),
              tasks: dbPlanTasks
                .filter((task) => task.plan_uuid === rawPlan.uuid)
                .map((task) => ({
                  title: task.title,
                  description: task.description,
                  done: Boolean(task.done),
                })),
              dependencies: dbPlanDependencies
                .filter((dependency) => dependency.plan_uuid === rawPlan.uuid)
                .map((dependency) => dependency.depends_on_uuid),
              tags: dbPlanTags
                .filter((tag) => tag.plan_uuid === rawPlan.uuid)
                .map((tag) => tag.tag),
              filename: rawPlan.filename,
              createdAt: rawPlan.created_at,
              updatedAt: rawPlan.updated_at ?? undefined,
            }
          : rawPlan;
      if (!plan) {
        const err = new Error(`No plan found in the database for identifier: ${planArg}`);
        err.name = 'PlanNotFoundError';
        throw err;
      }
      return { plan, planPath: path.join(tasksDir, `${plan.id}.plan.md`) };
    });

    const mockGetAssignmentEntriesByProject = vi.mocked(getAssignmentEntriesByProject);
    mockGetAssignmentEntriesByProject.mockImplementation(() => assignmentsData);
  });

  afterEach(async () => {
    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function addDbPlan(plan: Record<string, any>) {
    if (typeof plan.id !== 'number') {
      throw new Error('Test plan must include a numeric id');
    }

    const uuid = typeof plan.uuid === 'string' ? plan.uuid : `plan-${plan.id}`;
    dbPlans.push({
      ...plan,
      id: plan.id,
      uuid,
      title: plan.title ?? undefined,
      goal: plan.goal ?? '',
      details: plan.details ?? '',
      status: plan.status ?? 'pending',
      priority: plan.priority ?? undefined,
      branch: plan.branch ?? undefined,
      parent: plan.parent ?? undefined,
      discoveredFrom: plan.discoveredFrom ?? undefined,
      epic: Boolean(plan.epic),
      simple: Boolean(plan.simple),
      tdd: Boolean(plan.tdd),
      assignedTo: plan.assignedTo ?? undefined,
      issue: plan.issue ?? undefined,
      pullRequest: plan.pullRequest ?? undefined,
      docs: plan.docs ?? undefined,
      changedFiles: plan.changedFiles ?? undefined,
      temp: Boolean(plan.temp),
      baseBranch: plan.baseBranch ?? undefined,
      reviewIssues: plan.reviewIssues ?? undefined,
      planGeneratedAt: plan.planGeneratedAt ?? undefined,
      filename: `${plan.id}.plan.md`,
      createdAt: plan.createdAt ?? '2026-01-01T00:00:00.000Z',
      updatedAt: plan.updatedAt ?? undefined,
      tasks: plan.tasks ?? [],
      dependencies: plan.dependencies ?? [],
      tags: plan.tags ?? [],
    });
  }

  test('shows plan details when given valid plan ID', async () => {
    // Create a test plan
    const plan = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      priority: 'medium',
      tasks: [
        {
          title: 'Task 1',
          description: 'Do something',
          steps: [
            {
              prompt: 'Do step 1',
              done: true,
            },
            {
              prompt: 'Do step 2',
              done: false,
            },
          ],
        },
      ],
    };

    addDbPlan(plan);

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand('1', options, command);

    // Should display plan details
    expect(logSpy).toHaveBeenCalled();

    // Check that key information is displayed
    const logCalls = logSpy.mock.calls.map((call) => call[0]);
    const allOutput = logCalls.join('\n');
    const stripped = stripAnsi(allOutput);

    expect(stripped).toContain('Test Plan');
    expect(stripped).toContain('Test goal');
  });

  test('displays tags when present', async () => {
    const plan = {
      id: 50,
      title: 'Tagged Plan',
      goal: 'Check tags',
      status: 'pending',
      tags: ['frontend', 'urgent'],
      tasks: [],
    };

    addDbPlan(plan);

    await handleShowCommand('50', {}, { parent: { opts: () => ({}) } });

    const output = stripAnsi(logSpy.mock.calls.map((call) => call[0]).join('\n'));
    expect(output).toContain('Tags: frontend, urgent');
  });

  test('shows placeholder when no tags exist', async () => {
    const plan = {
      id: 51,
      title: 'Untagged Plan',
      goal: 'Check empty tags',
      status: 'pending',
      tasks: [],
    };

    addDbPlan(plan);

    await handleShowCommand('51', {}, { parent: { opts: () => ({}) } });

    const output = stripAnsi(logSpy.mock.calls.map((call) => call[0]).join('\n'));
    expect(output).toContain('Tags: none');
  });

  test('shows epic chain when epic is an indirect parent', async () => {
    const epic = {
      id: 1,
      title: 'Epic Plan',
      status: 'pending',
      epic: true,
      tasks: [],
    };
    const phase = {
      id: 2,
      title: 'Phase Plan',
      status: 'pending',
      parent: 1,
      tasks: [],
    };
    const child = {
      id: 3,
      title: 'Child Plan',
      status: 'pending',
      parent: 2,
      tasks: [],
    };

    addDbPlan(epic);
    addDbPlan(phase);
    addDbPlan(child);

    await handleShowCommand('3', {}, { parent: { opts: () => ({}) } });

    const output = stripAnsi(logSpy.mock.calls.map((call) => call[0]).join('\n'));
    expect(output).toContain('Epic: 1 - Epic Plan');
  });

  test('shows condensed summary with --short', async () => {
    const plan = {
      id: 2,
      title: 'Condensed Plan',
      goal: 'Should be hidden in short view',
      details: 'This detail text should not appear in short mode.',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task Title 1',
          description: 'Hidden description',
          done: true,
        },
        {
          title: 'Task Title 2',
          description: 'Another hidden description',
          done: false,
        },
      ],
    } as any;

    addDbPlan(plan);

    const options = { short: true } as any;
    const command = { parent: { opts: () => ({}) } } as any;

    await handleShowCommand('2', options, command);

    const logs = logSpy.mock.calls.map((call) => call[0]).join('\n');

    const stripped = stripAnsi(logs);

    expect(stripped).toContain('Plan Summary');
    expect(stripped).toContain('Condensed Plan');
    expect(stripped).toContain('Tasks:');
    expect(stripped).toContain('✓  1. Task Title 1');
    expect(stripped).toContain('○  2. Task Title 2');
    expect(stripped).not.toContain('Goal:');
    expect(stripped).not.toContain('Details:');
    expect(stripped).not.toContain('Hidden description');
  });

  test('shows error when plan file not found', async () => {
    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleShowCommand('nonexistent', options, command)).rejects.toThrow();
  });

  test('falls back to SQLite when the plan file is missing', async () => {
    dbPlans = [
      {
        uuid: '77777777-7777-4777-8777-777777777777',
        project_id: 1,
        plan_id: 77,
        title: 'SQLite fallback plan',
        goal: 'Loaded from sqlite',
        details: 'SQLite details',
        status: 'pending',
        priority: 'medium',
        branch: null,
        parent_uuid: null,
        epic: 0,
        filename: '77.plan.md',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    ];

    await handleShowCommand('77', {}, { parent: { opts: () => ({}) } });

    const output = stripAnsi(logSpy.mock.calls.map((call) => call[0]).join('\n'));
    expect(output).toContain('SQLite fallback plan');
    expect(output).toContain('Loaded from sqlite');
  });

  test('finds next ready plan with --next flag', async () => {
    // Clear the plan cache before creating plans

    // Create a simple pending plan with no dependencies
    const plan = {
      id: 1,
      title: 'Ready Plan',
      goal: 'Ready to start',
      details: 'Details',
      status: 'pending',
      priority: 'high',
      tasks: [
        {
          title: 'Task 1',
          description: 'Do task 1',
          steps: [
            {
              prompt: 'Do step 1',
              done: false,
            },
          ],
        },
      ],
    };

    addDbPlan(plan);

    const options = {
      next: true,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand(undefined, options, command);

    expect(logSpy).toHaveBeenCalled();
    const logCalls = logSpy.mock.calls.map((call) => call[0]);
    const allOutput = logCalls.join('\n');
    const stripped = stripAnsi(allOutput);

    expect(stripped).toContain('Found next ready plan: 1');
    expect(stripped).toContain('Ready Plan');
    expect(stripped).toContain('Ready to start');
  });

  test('finds current in-progress plan with --current flag', async () => {
    // Create plans
    const plans = [
      {
        id: 1,
        title: 'In Progress Plan',
        goal: 'Currently working on',
        details: 'Details',
        status: 'in_progress',
        tasks: [
          {
            title: 'Task 1',
            description: 'Do task',
            steps: [{ prompt: 'Do step', done: false }],
          },
        ],
      },
      {
        id: 2,
        title: 'Pending Plan',
        goal: 'Not started',
        details: 'Details',
        status: 'pending',
        tasks: [
          {
            title: 'Task 1',
            description: 'Do task',
            steps: [{ prompt: 'Do step', done: false }],
          },
        ],
      },
    ];

    for (const plan of plans) {
      addDbPlan(plan);
    }

    const options = {
      current: true,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand(undefined, options, command);

    expect(logSpy).toHaveBeenCalled();
    const logCalls = logSpy.mock.calls.map((call) => call[0]);
    const allOutput = logCalls.join('\n');
    const stripped = stripAnsi(allOutput);

    expect(stripped).toContain('Found current plan: 1');
    expect(stripped).toContain('In Progress Plan');
  });

  test('finds most recently updated plan with --latest flag', async () => {
    const olderTime = new Date('2024-01-01T00:00:00Z').toISOString();
    const newerTime = new Date('2024-03-05T10:00:00Z').toISOString();

    const plans = [
      {
        id: 10,
        title: 'Older Plan',
        goal: 'Earlier work',
        details: 'Older details',
        status: 'pending',
        updatedAt: olderTime,
        tasks: [],
      },
      {
        id: 11,
        title: 'Latest Plan',
        goal: 'Newest goal',
        details: 'Latest details',
        status: 'pending',
        updatedAt: newerTime,
        tasks: [],
      },
    ];

    for (const plan of plans) {
      addDbPlan(plan);
    }

    const options = {
      latest: true,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand(undefined, options, command);

    const logs = logSpy.mock.calls.map((call) => call[0]).join('\n');
    const stripped = stripAnsi(logs);

    expect(stripped).toContain('Found latest plan: 11 - Latest Plan');
    expect(stripped).toContain('Latest Plan');
    expect(stripped).toContain('Newest goal');
  });

  test('ignores plans without updatedAt field when using --latest flag', async () => {
    const newerTime = new Date('2024-03-05T10:00:00Z').toISOString();

    const plans = [
      {
        id: 12,
        title: 'Plan Without UpdatedAt',
        goal: 'No update timestamp',
        details: 'Should be ignored',
        status: 'pending',
        createdAt: new Date('2024-06-01T00:00:00Z').toISOString(),
        tasks: [],
      },
      {
        id: 13,
        title: 'Plan With UpdatedAt',
        goal: 'Has update timestamp',
        details: 'Should be selected',
        status: 'pending',
        updatedAt: newerTime,
        tasks: [],
      },
    ];

    for (const plan of plans) {
      addDbPlan(plan);
    }

    const options = {
      latest: true,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand(undefined, options, command);

    const logs = logSpy.mock.calls.map((call) => call[0]).join('\n');
    const stripped = stripAnsi(logs);

    expect(stripped).toContain('Found latest plan: 13 - Plan With UpdatedAt');
    expect(stripped).toContain('Has update timestamp');
    expect(stripped).not.toContain('Plan Without UpdatedAt');
  });

  test('shows message when no plans with updatedAt field found', async () => {
    const plan = {
      id: 14,
      title: 'Plan Without UpdatedAt',
      goal: 'No update timestamp',
      details: 'Only has createdAt',
      status: 'pending',
      createdAt: new Date('2024-06-01T00:00:00Z').toISOString(),
      tasks: [],
    };

    addDbPlan(plan);

    const options = {
      latest: true,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand(undefined, options, command);

    expect(logSpy).toHaveBeenCalledWith('No plans with updatedAt field found in database.');
  });

  test('follows DB-backed dependencies when selecting the next ready plan', async () => {
    addDbPlan({
      id: 1,
      title: 'Blocked Plan',
      goal: 'Blocked by dependencies',
      details: 'Details',
      status: 'pending',
      dependencies: [2],
      tasks: [
        {
          title: 'Task 1',
          description: 'Do task',
          steps: [{ prompt: 'Do step', done: false }],
        },
      ],
    });
    addDbPlan({
      id: 2,
      title: 'Incomplete Dependency',
      goal: 'Still pending',
      details: 'Details',
      status: 'pending',
      tasks: [
        {
          title: 'Task 1',
          description: 'Do task',
          steps: [{ prompt: 'Do step', done: false }],
        },
      ],
    });

    const options = {
      next: true,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand(undefined, options, command);

    const output = stripAnsi(logSpy.mock.calls.map((call) => call[0]).join('\n'));
    expect(output).toContain('Found next ready plan: 2');
    expect(output).toContain('Incomplete Dependency');
  });

  test('shows error when no plan file provided and no flags', async () => {
    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleShowCommand(undefined, options, command)).rejects.toThrow(
      'Please provide a plan file or use --latest/--next/--current/--next-ready to find a plan'
    );
  });

  test('uses the current branch plan ID when no plan file is provided', async () => {
    currentBranchName = '42-branch-selected-plan';

    const plan = {
      id: 42,
      title: 'Branch Selected Plan',
      goal: 'Infer from branch name',
      details: 'Selected automatically',
      status: 'pending',
      tasks: [],
    };

    addDbPlan(plan);

    await handleShowCommand(undefined, {}, { parent: { opts: () => ({}) } });

    const output = stripAnsi(logSpy.mock.calls.map((call) => call[0]).join('\n'));
    expect(output).toContain(
      'Using plan ID 42 from current branch/bookmark: 42-branch-selected-plan'
    );
    expect(output).toContain('Branch Selected Plan');
  });

  test('does not infer a plan ID from branch names without a separator', async () => {
    currentBranchName = '42branch-selected-plan';

    await expect(
      handleShowCommand(undefined, {}, { parent: { opts: () => ({}) } })
    ).rejects.toThrow(
      'Please provide a plan file or use --latest/--next/--current/--next-ready to find a plan'
    );
  });

  test('displays workspace and user assignments when present', async () => {
    const now = new Date().toISOString();
    const plan = {
      id: 8,
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Assignment Plan',
      goal: 'Show assignment info',
      status: 'pending',
      tasks: [],
    };

    addDbPlan(plan);

    assignmentsData = {
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': {
        planId: 8,
        workspacePaths: [repoDir],
        users: ['alice'],
        status: 'in_progress',
        assignedAt: now,
        updatedAt: now,
      },
    };

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand('8', options, command);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    const stripped = stripAnsi(output);
    expect(stripped).toContain('Workspace:');
    expect(stripped).toContain('Users: alice');
  });

  test('warns when a plan is claimed in multiple workspaces', async () => {
    const plan = {
      id: 9,
      uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Conflicted Plan',
      goal: 'Warn on conflicts',
      status: 'pending',
      tasks: [],
    };

    addDbPlan(plan);

    assignmentsData = {
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': {
        planId: 9,
        workspacePaths: [repoDir, path.join(tempDir, 'other-workspace')],
        users: ['alice', 'bob'],
        status: 'pending',
        assignedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand('9', options, command);

    expect(warnSpy).toHaveBeenCalled();
  });

  test('falls back to assignedTo when no shared assignment exists', async () => {
    const plan = {
      id: 10,
      title: 'Legacy Assignment Plan',
      goal: 'Check assignedTo fallback',
      status: 'pending',
      assignedTo: 'carol',
      tasks: [],
    };

    addDbPlan(plan);

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand('10', options, command);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    const stripped = stripAnsi(output);
    expect(stripped).toContain('Assigned To: carol');
  });
});

describe('mcpGetPlan', () => {
  test('returns formatted plan context for the given plan id', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-mcp-get-plan-'));

    try {
      const dbPlans = [
        {
          uuid: 'plan-200',
          project_id: 1,
          plan_id: 200,
          title: 'MCP integration plan',
          goal: 'Ensure MCP server shares logic',
          details: 'Detailed info for MCP consumers.',
          status: 'pending',
          priority: 'high',
          branch: null,
          parent_uuid: null,
          discovered_from: null,
          epic: 0,
          simple: 0,
          tdd: 0,
          assigned_to: null,
          issue: null,
          pull_request: null,
          docs: null,
          changed_files: null,
          temp: 0,
          base_branch: null,
          review_issues: null,
          plan_generated_at: null,
          filename: '200.plan.md',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: null,
        },
      ];
      const dbPlanTasks = [
        {
          plan_uuid: 'plan-200',
          title: 'Refactor MCP server',
          description: 'Move handlers into command modules',
          done: 0,
        },
      ];

      vi.mocked(getRepositoryIdentity).mockResolvedValue({
        repositoryId: 'mcp-tests',
        remoteUrl: 'https://example.com/repo.git',
        gitRoot: tempDir,
      });
      vi.mocked(getDatabase).mockReturnValue(fakeDb as any);
      vi.mocked(getProject).mockReturnValue({ id: 1 } as any);
      vi.mocked(getOrCreateProject).mockReturnValue({ id: 1 } as any);
      vi.mocked(resolvePlan).mockResolvedValue({
        plan: {
          id: 200,
          uuid: 'plan-200',
          title: 'MCP integration plan',
          goal: 'Ensure MCP server shares logic',
          details: 'Detailed info for MCP consumers.',
          status: 'pending',
          priority: 'high',
          tasks: [
            {
              title: 'Refactor MCP server',
              description: 'Move handlers into command modules',
              done: false,
            },
          ],
        },
        planPath: null,
      });

      const context: GenerateModeRegistrationContext = {
        config: {} as any,
        gitRoot: tempDir,
      };

      const result = await mcpGetPlan({ plan: '200' }, context);

      expect(result).toContain('Plan file: Plan 200');
      expect(result).toContain('Plan ID: 200');
      expect(result).toContain('Status: pending');
      expect(result).toContain('Priority: high');
      expect(result).toContain('Title: MCP integration plan');
      expect(result).toContain('Goal:\nEnsure MCP server shares logic');
      expect(result).toContain('Details:\nDetailed info for MCP consumers.');
      expect(result).toContain('### Existing Tasks');
    } finally {
      vi.clearAllMocks();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('inverse relationships', () => {
  let tempDir: string;
  let repoDir: string;
  let tasksDir: string;
  let dbPlans: any[];
  let dbPlanTasks: any[];
  let dbPlanDependencies: any[];
  let dbPlanTags: any[];

  beforeEach(async () => {
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-inverse-test-'));
    repoDir = path.join(tempDir, 'repo');
    tasksDir = path.join(repoDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    dbPlans = [];
    dbPlanTasks = [];
    dbPlanDependencies = [];
    dbPlanTags = [];

    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      paths: {
        tasks: tasksDir,
      },
    } as any);
    vi.mocked(getRepositoryIdentity).mockResolvedValue({
      repositoryId: 'test-repo',
      remoteUrl: 'https://example.com/repo.git',
      gitRoot: repoDir,
    });
    vi.mocked(getDatabase).mockReturnValue(fakeDb as any);
    vi.mocked(getProject).mockReturnValue({ id: 1 } as any);
    vi.mocked(getOrCreateProject).mockReturnValue({ id: 1 } as any);
    vi.mocked(getAssignmentEntriesByProject).mockReturnValue({});
    vi.mocked(loadPlansFromDb).mockImplementation(() => {
      const plans = new Map();
      for (const plan of dbPlans) {
        plans.set(plan.id, plan);
      }
      return { plans, duplicates: {} } as any;
    });
    vi.mocked(resolvePlan).mockImplementation(async (planArg: string) => {
      const parsedId = Number.parseInt(String(planArg), 10);
      const plan = dbPlans.find((candidate) => candidate.id === parsedId);
      if (!plan) {
        const err = new Error(`No plan found in the database for identifier: ${planArg}`);
        err.name = 'PlanNotFoundError';
        throw err;
      }
      return { plan, planPath: path.join(tasksDir, `${plan.id}.plan.md`) };
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function addDbPlan(plan: Record<string, any>) {
    if (typeof plan.id !== 'number') {
      throw new Error('Test plan must include a numeric id');
    }

    const uuid = typeof plan.uuid === 'string' ? plan.uuid : `plan-${plan.id}`;
    dbPlans.push({
      ...plan,
      id: plan.id,
      uuid,
      title: plan.title ?? undefined,
      goal: plan.goal ?? '',
      details: plan.details ?? '',
      status: plan.status ?? 'pending',
      priority: plan.priority ?? undefined,
      parent: plan.parent ?? undefined,
      discoveredFrom: plan.discoveredFrom ?? undefined,
      epic: Boolean(plan.epic),
      tasks: plan.tasks ?? [],
      dependencies: plan.dependencies ?? [],
      tags: plan.tags ?? [],
      filename: `${plan.id}.plan.md`,
      createdAt: plan.createdAt ?? '2026-01-01T00:00:00.000Z',
      updatedAt: plan.updatedAt ?? undefined,
    });
  }

  test('displays blocked plans in full mode', async () => {
    const plans = [
      {
        id: 100,
        title: 'Parent Plan',
        goal: 'Base plan',
        status: 'done',
        tasks: [],
      },
      {
        id: 101,
        title: 'Dependent Plan 1',
        goal: 'Depends on 100',
        status: 'in_progress',
        dependencies: [100],
        tasks: [],
      },
      {
        id: 102,
        title: 'Dependent Plan 2',
        goal: 'Also depends on 100',
        status: 'pending',
        dependencies: [100],
        tasks: [],
      },
    ];

    for (const plan of plans) {
      addDbPlan(plan);
    }

    await handleShowCommand('100', {}, { parent: { opts: () => ({}) } } as any);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    const stripped = stripAnsi(output);

    expect(stripped).toContain('Blocks These Plans:');
    expect(stripped).toContain('101 - Dependent Plan 1');
    expect(stripped).toContain('102 - Dependent Plan 2');
  });

  test('displays child plans in full mode', async () => {
    const plans = [
      {
        id: 200,
        title: 'Parent Plan',
        goal: 'Has children',
        status: 'in_progress',
        tasks: [],
      },
      {
        id: 201,
        title: 'Child Plan 1',
        goal: 'Child of 200',
        status: 'done',
        parent: 200,
        tasks: [],
      },
      {
        id: 202,
        title: 'Child Plan 2',
        goal: 'Also child of 200',
        status: 'pending',
        parent: 200,
        tasks: [],
      },
    ];

    for (const plan of plans) {
      addDbPlan(plan);
    }

    await handleShowCommand('200', {}, { parent: { opts: () => ({}) } } as any);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    const stripped = stripAnsi(output);

    expect(stripped).toContain('Child Plans:');
    expect(stripped).toContain('201 - Child Plan 1');
    expect(stripped).toContain('202 - Child Plan 2');
  });

  test('displays discovered plans in full mode', async () => {
    const plans = [
      {
        id: 300,
        title: 'Source Plan',
        goal: 'Discovered others during research',
        status: 'done',
        tasks: [],
      },
      {
        id: 301,
        title: 'Discovered Plan 1',
        goal: 'Found during plan 300',
        status: 'pending',
        discoveredFrom: 300,
        tasks: [],
      },
      {
        id: 302,
        title: 'Discovered Plan 2',
        goal: 'Also found during plan 300',
        status: 'pending',
        discoveredFrom: 300,
        tasks: [],
      },
    ];

    for (const plan of plans) {
      addDbPlan(plan);
    }

    await handleShowCommand('300', {}, { parent: { opts: () => ({}) } } as any);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    const stripped = stripAnsi(output);

    expect(stripped).toContain('Plans Discovered From This:');
    // Verify status icons are present (○ for pending plans)
    expect(stripped).toContain('○ 301 - Discovered Plan 1');
    expect(stripped).toContain('○ 302 - Discovered Plan 2');
  });

  test('displays status icons correctly for different plan statuses', async () => {
    const plans = [
      {
        id: 350,
        title: 'Parent Plan',
        goal: 'Main plan',
        status: 'pending',
        tasks: [],
      },
      {
        id: 351,
        title: 'Pending Plan',
        goal: 'Not started',
        status: 'pending',
        dependencies: [350],
        discoveredFrom: 350,
        tasks: [],
      },
      {
        id: 352,
        title: 'In Progress Plan',
        goal: 'Currently working',
        status: 'in_progress',
        dependencies: [350],
        discoveredFrom: 350,
        tasks: [],
      },
      {
        id: 353,
        title: 'Done Plan',
        goal: 'Completed',
        status: 'done',
        dependencies: [350],
        discoveredFrom: 350,
        tasks: [],
      },
    ];

    for (const plan of plans) {
      addDbPlan(plan);
    }

    await handleShowCommand('350', {}, { parent: { opts: () => ({}) } } as any);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    const stripped = stripAnsi(output);

    // Verify different status icons
    expect(stripped).toContain('○ 351 - Pending Plan'); // pending icon
    expect(stripped).toContain('⏳ 352 - In Progress Plan'); // in_progress icon
    expect(stripped).toContain('✓ 353 - Done Plan'); // done icon
  });

  test('displays discovered from source in full mode', async () => {
    const plans = [
      {
        id: 400,
        title: 'Source Plan',
        goal: 'Original plan',
        status: 'done',
        tasks: [],
      },
      {
        id: 401,
        title: 'Discovered Plan',
        goal: 'Found during research',
        status: 'pending',
        discoveredFrom: 400,
        tasks: [],
      },
    ];

    for (const plan of plans) {
      addDbPlan(plan);
    }

    await handleShowCommand('401', {}, { parent: { opts: () => ({}) } } as any);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    const stripped = stripAnsi(output);

    expect(stripped).toContain('Discovered From:');
    expect(stripped).toContain('400 - Source Plan');
  });

  test('handles missing inverse relationship references gracefully', async () => {
    const plan = {
      id: 500,
      title: 'Orphan Plan',
      goal: 'References non-existent source',
      status: 'pending',
      discoveredFrom: 999,
      tasks: [],
    };

    addDbPlan(plan);

    await handleShowCommand('500', {}, { parent: { opts: () => ({}) } } as any);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    const stripped = stripAnsi(output);

    expect(stripped).toContain('Discovered From:');
    expect(stripped).toContain('999');
    expect(stripped).toContain('[Plan not found]');
  });

  test('does not show inverse relationship sections in short mode', async () => {
    const plans = [
      {
        id: 600,
        title: 'Parent Plan',
        goal: 'Has relationships',
        status: 'done',
        tasks: [],
      },
      {
        id: 601,
        title: 'Child Plan',
        goal: 'Child of 600',
        status: 'pending',
        parent: 600,
        tasks: [],
      },
    ];

    for (const plan of plans) {
      addDbPlan(plan);
    }

    await handleShowCommand('600', { short: true }, { parent: { opts: () => ({}) } } as any);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    const stripped = stripAnsi(output);

    expect(stripped).not.toContain('Child Plans:');
    expect(stripped).not.toContain('Blocks These Plans:');
    expect(stripped).not.toContain('Plans Discovered From This:');
  });

  test('displays full details without truncation with --full flag', async () => {
    const longDetails = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of details`).join('\n');

    const plan = {
      id: 700,
      title: 'Long Details Plan',
      goal: 'Test details display',
      status: 'pending',
      details: longDetails,
      tasks: [],
    };

    addDbPlan(plan);

    // Test without --full flag (should truncate)
    await handleShowCommand('700', {}, { parent: { opts: () => ({}) } } as any);
    let output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    let stripped = stripAnsi(output);

    expect(stripped).toContain('Line 1 of details');
    expect(stripped).toContain('Line 20 of details');
    expect(stripped).toContain('... and 10 more lines');
    expect(stripped).not.toContain('Line 25 of details');

    // Clear logs and test with --full flag (should show all)
    logSpy.mockClear();
    await handleShowCommand('700', { full: true }, { parent: { opts: () => ({}) } } as any);
    output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    stripped = stripAnsi(output);

    expect(stripped).toContain('Line 1 of details');
    expect(stripped).toContain('Line 20 of details');
    expect(stripped).toContain('Line 25 of details');
    expect(stripped).toContain('Line 30 of details');
    expect(stripped).not.toContain('... and');
  });
});
