import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearConfigCache } from '../configLoader.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { writePlanFile } from '../plans.js';
import { makeSubagentPlanFixture } from '../commands/subagent.test-helpers.js';
import type { PlanSchema } from '../planSchema.js';
import type { TimConfig } from '../configSchema.js';
import type { ReviewIssue } from '../formatters/review_formatter.js';
import {
  buildRemediationPlanInput,
  generateRemediationPlan,
  shouldGenerateRemediationPlan,
} from './remediation_plan.js';

const providerMocks = vi.hoisted(() => ({
  executeCodexStep: vi.fn(),
  runClaudeSubprocess: vi.fn(),
}));

vi.mock('../executors/codex_cli/codex_runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../executors/codex_cli/codex_runner.js')>()),
  executeCodexStep: providerMocks.executeCodexStep,
}));

vi.mock('../executors/claude_code/run_claude_subprocess.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../executors/claude_code/run_claude_subprocess.js')>()),
  runClaudeSubprocess: providerMocks.runClaudeSubprocess,
}));

function issue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    severity: 'major',
    category: 'bug',
    content: 'The queue drops a message when the worker restarts.',
    file: 'src/queue.ts',
    line: 42,
    suggestion: 'Re-enqueue on restart.',
    ...overrides,
  };
}

function configWithAdvisor(overrides: Partial<TimConfig> = {}): TimConfig {
  return {
    subagents: { advisor: { executor: 'claude-code', model: { claude: 'opus' } } },
    ...overrides,
  } as TimConfig;
}

describe('shouldGenerateRemediationPlan', () => {
  test('runs for a full-scope review with a blocking finding when the advisor is configured', () => {
    expect(
      shouldGenerateRemediationPlan({
        config: configWithAdvisor(),
        isFullScopeReview: true,
        issues: [issue()],
      })
    ).toBe(true);
  });

  test('does not run when no advisor is configured', () => {
    expect(
      shouldGenerateRemediationPlan({
        config: {} as TimConfig,
        isFullScopeReview: true,
        issues: [issue()],
      })
    ).toBe(false);

    // An executor without a matching model leaves the advisor unresolved.
    expect(
      shouldGenerateRemediationPlan({
        config: { subagents: { advisor: { executor: 'claude-code' } } } as TimConfig,
        isFullScopeReview: true,
        issues: [issue()],
      })
    ).toBe(false);
  });

  test('does not run for a task-scoped review or a review with no findings', () => {
    expect(
      shouldGenerateRemediationPlan({
        config: configWithAdvisor(),
        isFullScopeReview: false,
        issues: [issue()],
      })
    ).toBe(false);

    expect(
      shouldGenerateRemediationPlan({
        config: configWithAdvisor(),
        isFullScopeReview: true,
        issues: [],
      })
    ).toBe(false);
  });

  test('requires a blocking finding unless the flag asks for it explicitly', () => {
    const minorOnly = [issue({ severity: 'minor' }), issue({ severity: 'info' })];

    expect(
      shouldGenerateRemediationPlan({
        config: configWithAdvisor(),
        isFullScopeReview: true,
        issues: minorOnly,
      })
    ).toBe(false);

    expect(
      shouldGenerateRemediationPlan({
        config: configWithAdvisor(),
        cliOverride: true,
        isFullScopeReview: true,
        issues: minorOnly,
      })
    ).toBe(true);

    expect(
      shouldGenerateRemediationPlan({
        config: configWithAdvisor(),
        isFullScopeReview: true,
        issues: [issue({ severity: 'critical' })],
      })
    ).toBe(true);
  });

  test('honors the config toggle and lets --no-remediation-plan win over everything', () => {
    const config = configWithAdvisor({ review: { remediationPlan: false } } as Partial<TimConfig>);

    expect(
      shouldGenerateRemediationPlan({ config, isFullScopeReview: true, issues: [issue()] })
    ).toBe(false);

    // An explicit flag overrides the config opt-out.
    expect(
      shouldGenerateRemediationPlan({
        config,
        cliOverride: true,
        isFullScopeReview: true,
        issues: [issue()],
      })
    ).toBe(true);

    expect(
      shouldGenerateRemediationPlan({
        config: configWithAdvisor(),
        cliOverride: false,
        isFullScopeReview: true,
        issues: [issue()],
      })
    ).toBe(false);
  });
});

describe('buildRemediationPlanInput', () => {
  const input = buildRemediationPlanInput({
    planId: 42,
    planTitle: 'Test Plan',
    reviewScope: 'the full plan',
    issues: [
      issue(),
      issue({
        severity: 'minor',
        category: 'style',
        content: 'Name is confusing.',
        file: undefined,
        line: undefined,
        suggestion: undefined,
      }),
    ],
    recommendations: ['Consolidate the retry paths.'],
    actionItems: ['Add a restart test.'],
  });

  test('restates every finding with its severity and location', () => {
    expect(input).toContain('1. [MAJOR] bug');
    expect(input).toContain('Location: src/queue.ts:42');
    expect(input).toContain('The queue drops a message when the worker restarts.');
    expect(input).toContain('Reviewer suggestion: Re-enqueue on restart.');
    expect(input).toContain('2. [MINOR] style');
    expect(input).toContain('Location: No file specified');
  });

  test('includes the plan, scope, recommendations, and action items', () => {
    expect(input).toContain('plan 42 (Test Plan)');
    expect(input).toContain('Review scope: the full plan');
    expect(input).toContain('- Consolidate the retry paths.');
    expect(input).toContain('- Add a restart test.');
  });

  test('asks for root causes and an ordered plan rather than per-finding patches', () => {
    expect(input).toContain('Root causes');
    expect(input).toContain('Ordered remediation steps');
    expect(input).toContain('Findings to reject or defer');
    expect(input).toContain('Verification');
    expect(input).toContain('push the defect one level up or down');
  });

  test('omits the recommendation and action-item sections when the review had none', () => {
    const bare = buildRemediationPlanInput({
      planId: 7,
      planTitle: 'Bare',
      reviewScope: 'the full plan',
      issues: [issue()],
      recommendations: [],
      actionItems: ['   '],
    });

    expect(bare).not.toContain('## Reviewer Recommendations');
    expect(bare).not.toContain('## Reviewer Action Items');
  });
});

describe('generateRemediationPlan', () => {
  let repositoryRoot: string;
  let tasksDirectory: string;
  let configPath: string;
  let originalXdgConfigHome: string | undefined;

  beforeEach(async () => {
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-remediation-plan-'));
    tasksDirectory = path.join(repositoryRoot, 'tasks');
    configPath = path.join(repositoryRoot, '.tim.yml');
    process.env.XDG_CONFIG_HOME = path.join(repositoryRoot, 'config-home');
    await fs.mkdir(tasksDirectory, { recursive: true });
    await Bun.$`git init`.cwd(repositoryRoot).quiet();
    await Bun.$`git config user.email test@example.com`.cwd(repositoryRoot).quiet();
    await Bun.$`git config user.name "Test User"`.cwd(repositoryRoot).quiet();
    await fs.writeFile(
      configPath,
      [
        'paths:',
        `  tasks: ${JSON.stringify(tasksDirectory)}`,
        'defaultExecutor: claude-code',
        'subagents:',
        '  advisor:',
        '    executor: codex-cli',
        '    model:',
        '      codex: gpt-6:high',
        '',
      ].join('\n'),
      'utf8'
    );
    clearConfigCache();

    const plan: PlanSchema = {
      ...makeSubagentPlanFixture(),
      uuid: '42424242-4242-4242-8242-424242424242',
    };
    const config: TimConfig = { paths: { tasks: tasksDirectory } };
    await writePlanFile(path.join(tasksDirectory, '42-test-plan.plan.md'), plan, {
      cwdForIdentity: repositoryRoot,
      config,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    providerMocks.executeCodexStep.mockReset();
    providerMocks.runClaudeSubprocess.mockReset();
    closeDatabaseForTesting();
    clearConfigCache();
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    await fs.rm(repositoryRoot, { recursive: true, force: true });
  });

  test("runs the advisor with its own executor and returns the advisor's plan", async () => {
    providerMocks.executeCodexStep.mockResolvedValue('  ## Root causes\nOne shared invariant.  ');

    const result = await generateRemediationPlan({
      planId: 42,
      planTitle: 'Test Plan for Subagent',
      reviewScope: 'the full plan',
      issues: [issue()],
      configPath,
      repositoryRoot,
    });

    expect(result.executor).toBe('codex-cli');
    expect(result.remediationPlan).toBe('## Root causes\nOne shared invariant.');
    expect(providerMocks.runClaudeSubprocess).not.toHaveBeenCalled();
    expect(providerMocks.executeCodexStep).toHaveBeenCalledTimes(1);

    const [prompt, cwd, , options] = providerMocks.executeCodexStep.mock.calls[0];
    expect(cwd).toBe(repositoryRoot);
    expect(options.model).toBe('gpt-6');
    expect(prompt).toContain('You are a tim advisor agent');
    expect(prompt).toContain('# Remediation Planning Request');
    expect(prompt).toContain('The queue drops a message when the worker restarts.');
    expect(prompt).toContain('Ordered remediation steps');
  });

  test('propagates a provider failure so the caller decides what it means', async () => {
    providerMocks.executeCodexStep.mockRejectedValue(new Error('advisor exploded'));

    await expect(
      generateRemediationPlan({
        planId: 42,
        planTitle: 'Test Plan for Subagent',
        reviewScope: 'the full plan',
        issues: [issue()],
        configPath,
        repositoryRoot,
      })
    ).rejects.toThrow('advisor exploded');
  });
});
