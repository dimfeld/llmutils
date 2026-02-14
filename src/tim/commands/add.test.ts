import { $ } from 'bun';
import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { readPlanFile, getMaxNumericPlanId } from '../plans.js';
import { ModuleMocker, clearAllTimCaches, stringifyPlanWithFrontmatter } from '../../testing.js';
import { getDefaultConfig } from '../configSchema.js';
import { handleAddCommand } from './add.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('tim add command', () => {
  let tempDir: string;
  let tasksDir: string;
  const moduleMocker = new ModuleMocker(import.meta);

  beforeEach(async () => {
    // Clear all caches before starting each test
    clearAllTimCaches();

    // Mock generateNumericPlanId to use local-only ID generation (avoids shared storage)
    await moduleMocker.mock('../id_utils.js', () => ({
      generateNumericPlanId: mock(async (dir: string) => {
        const maxId = await getMaxNumericPlanId(dir);
        return maxId + 1;
      }),
    }));

    // Create temporary directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-add-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Create config file that points to tasks directory
    const configPath = path.join(tempDir, '.rmfilter', 'tim.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: {
          tasks: tasksDir,
        },
      })
    );
  });

  afterEach(async () => {
    moduleMocker.clear();
    clearAllTimCaches();

    // Clean up the temporary directory
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (err) {
        console.error('Failed to clean up temp directory:', tempDir, err);
      }
    }
  });

  test('creates plan with numeric ID when no plans exist', async () => {
    // Run handler directly
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['Test', 'Title'], {}, command);

    // The file should be named 1-test-title.plan.md since no plans exist
    const planPath = path.join(tasksDir, '1-test-title.plan.md');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const plan = await readPlanFile(planPath);
    expect(plan.id).toBe(1);
    expect(plan.uuid).toMatch(UUID_REGEX);
    expect(plan.title).toBe('Test Title');
    expect(plan.goal).toBe('');
    expect(plan.details).toBe('');
    expect(plan.status).toBe('pending');
    expect(plan.tasks).toEqual([]);
  });

  test('creates plan with next numeric ID when plans exist', async () => {
    // Create existing plan files with proper schema comment
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';

    await fs.writeFile(
      path.join(tasksDir, '50.yml'),
      stringifyPlanWithFrontmatter({
        id: 50,
        title: 'Existing Plan 50',
        goal: 'Test goal',
        details: 'Test details',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );
    await fs.writeFile(
      path.join(tasksDir, '100.yml'),
      stringifyPlanWithFrontmatter({
        id: 100,
        title: 'Existing Plan 100',
        goal: 'Test goal',
        details: 'Test details',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );

    // Run handler directly
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['New', 'Plan', 'Title'], {}, command);

    // The file should be named 101-new-plan-title.plan.md (max ID was 100)
    const planPath = path.join(tasksDir, '101-new-plan-title.plan.md');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const plan = await readPlanFile(planPath);
    expect(plan.id).toBe(101);
    expect(plan.title).toBe('New Plan Title');
  });

  test('creates plan with numeric ID ignoring non-numeric plan files', async () => {
    // Create existing plan files with non-numeric and numeric names
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';

    await fs.writeFile(
      path.join(tasksDir, 'old-plan.yml'),
      stringifyPlanWithFrontmatter({
        id: 'abc123',
        title: 'Old Alphanumeric Plan',
        goal: 'Test goal',
        details: 'Test details',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );
    await fs.writeFile(
      path.join(tasksDir, '5.yml'),
      stringifyPlanWithFrontmatter({
        id: 5,
        title: 'Numeric Plan 5',
        goal: 'Test goal',
        details: 'Test details',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );

    // Run handler directly
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['Another', 'Plan'], {}, command);

    // The file should be named 6-another-plan.plan.md (max numeric ID was 5)
    const planPath = path.join(tasksDir, '6-another-plan.plan.md');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const plan = await readPlanFile(planPath);
    expect(plan.id).toBe(6);
    expect(plan.title).toBe('Another Plan');
  });

  test('creates plan within external storage when repository uses external config', async () => {
    const externalBase = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-add-external-'));
    const repositoryConfigDir = path.join(externalBase, 'repositories', 'example');
    const externalTasksDir = path.join(repositoryConfigDir, 'tasks');
    await fs.mkdir(externalTasksDir, { recursive: true });

    const config = {
      ...getDefaultConfig(),
      paths: undefined,
      isUsingExternalStorage: true,
      externalRepositoryConfigDir: repositoryConfigDir,
      resolvedConfigPath: path.join(repositoryConfigDir, '.rmfilter', 'config', 'tim.yml'),
      repositoryConfigName: 'example',
      repositoryRemoteUrl: null,
    };

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => config),
    }));

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleAddCommand(['External', 'Plan'], {}, command);

    const createdPath = path.join(externalTasksDir, '1-external-plan.plan.md');
    const exists = await fs
      .access(createdPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    await fs.rm(externalBase, { recursive: true, force: true });
  });

  test('handles multi-word titles correctly', async () => {
    // Run handler directly with multi-word title
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['This', 'is', 'a', 'Multi', 'Word', 'Title'], {}, command);

    // The file should be named 1-this-is-a-multi-word-title.plan.md
    const planPath = path.join(tasksDir, '1-this-is-a-multi-word-title.plan.md');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const plan = await readPlanFile(planPath);
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('This is a Multi Word Title');
  });

  test('adds dependencies and priority correctly', async () => {
    // Create existing plans to depend on
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';

    await fs.writeFile(
      path.join(tasksDir, '1.yml'),
      stringifyPlanWithFrontmatter({
        id: 1,
        title: 'Dependency 1',
        goal: 'Test goal',
        details: 'Test details',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );
    await fs.writeFile(
      path.join(tasksDir, '2.yml'),
      stringifyPlanWithFrontmatter({
        id: 2,
        title: 'Dependency 2',
        goal: 'Test goal',
        details: 'Test details',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );

    // Run handler directly with dependencies and priority
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(
      ['Plan', 'with', 'Dependencies'],
      { dependsOn: [1, 2], priority: 'high' },
      command
    );

    // The file should be named 3-plan-with-dependencies.plan.md
    const planPath = path.join(tasksDir, '3-plan-with-dependencies.plan.md');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const plan = await readPlanFile(planPath);

    expect(plan.id).toBe(3);
    expect(plan.title).toBe('Plan with Dependencies');
    expect(plan.dependencies).toEqual([1, 2]);
    expect(plan.priority).toBe('high');

    // References should be populated for both dependencies
    expect(plan.references).toBeDefined();
    expect(plan.references![1]).toMatch(UUID_REGEX);
    expect(plan.references![2]).toMatch(UUID_REGEX);

    // Referenced plans should have UUIDs generated
    const dep1 = await readPlanFile(path.join(tasksDir, '1.yml'));
    const dep2 = await readPlanFile(path.join(tasksDir, '2.yml'));
    expect(dep1.uuid).toMatch(UUID_REGEX);
    expect(dep2.uuid).toMatch(UUID_REGEX);
    expect(plan.references![1]).toBe(dep1.uuid);
    expect(plan.references![2]).toBe(dep2.uuid);
  });

  test('creates plan with parent and updates parent dependencies', async () => {
    // Create a parent plan
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';

    const parentCreatedAt = new Date().toISOString();
    await fs.writeFile(
      path.join(tasksDir, '1-parent-plan.yml'),
      stringifyPlanWithFrontmatter({
        id: 1,
        title: 'Parent Plan',
        goal: 'Test parent goal',
        details: 'Test parent details',
        status: 'pending',
        createdAt: parentCreatedAt,
        updatedAt: parentCreatedAt,
        tasks: [],
      })
    );

    // Add a small delay to ensure timestamps are different
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Run handler directly with parent option
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['Child', 'Plan'], { parent: 1 }, command);

    // The child file should be named 2-child-plan.plan.md
    const childPlanPath = path.join(tasksDir, '2-child-plan.plan.md');
    expect(
      await fs.access(childPlanPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify child plan content
    const childPlan = await readPlanFile(childPlanPath);
    expect(childPlan.id).toBe(2);
    expect(childPlan.title).toBe('Child Plan');
    expect(childPlan.parent).toBe(1);
    // Child plan should have a reference to its parent
    expect(childPlan.references).toBeDefined();
    expect(childPlan.references![1]).toBeDefined();

    // Read and verify parent plan was updated
    const parentPlanPath = path.join(tasksDir, '1-parent-plan.yml');
    const parentPlan = await readPlanFile(parentPlanPath);
    expect(parentPlan.dependencies).toEqual([2]);
    expect(new Date(parentPlan.updatedAt!).getTime()).toBeGreaterThan(
      new Date(parentCreatedAt).getTime()
    );
    // Parent plan should have a reference to the child
    expect(parentPlan.references).toBeDefined();
    expect(parentPlan.references![2]).toBe(childPlan.uuid);
    // Parent plan should have a UUID (generated by ensureReferences if missing)
    expect(parentPlan.uuid).toMatch(UUID_REGEX);
    // Child's reference to parent should match the parent's UUID
    expect(childPlan.references![1]).toBe(parentPlan.uuid);
  });

  test('errors when parent plan does not exist', async () => {
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await expect(handleAddCommand(['Orphan', 'Plan'], { parent: 999 }, command)).rejects.toThrow(
      'Parent plan with ID 999 not found'
    );
  });

  describe('--cleanup option', () => {
    test('creates cleanup plan with default title generation', async () => {
      // Create a parent plan
      const schemaLine =
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';

      await fs.writeFile(
        path.join(tasksDir, '10-parent-plan.yml'),
        stringifyPlanWithFrontmatter({
          id: 10,
          title: 'Parent Plan',
          goal: 'Test parent goal',
          details: 'Test parent details',
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        })
      );

      // Run handler directly with --cleanup option (no custom title)
      const command = {
        parent: {
          opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
        },
      };
      await handleAddCommand([], { cleanup: 10 }, command);

      // The cleanup file should be named 11-parent-plan-cleanup.plan.md
      const cleanupPlanPath = path.join(tasksDir, '11-parent-plan-cleanup.plan.md');
      expect(
        await fs.access(cleanupPlanPath).then(
          () => true,
          () => false
        )
      ).toBe(true);

      // Read and verify cleanup plan content
      const cleanupPlan = await readPlanFile(cleanupPlanPath);
      expect(cleanupPlan.id).toBe(11);
      expect(cleanupPlan.title).toBe('Parent Plan - Cleanup');
      expect(cleanupPlan.parent).toBe(10);
      expect(cleanupPlan.status).toBe('pending');

      // Read and verify parent plan was updated with dependency
      const parentPlanPath = path.join(tasksDir, '10-parent-plan.yml');
      const parentPlan = await readPlanFile(parentPlanPath);
      expect(parentPlan.dependencies).toEqual([11]);
    });

    test('creates cleanup plan with custom title', async () => {
      // Create a parent plan
      const schemaLine =
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';

      await fs.writeFile(
        path.join(tasksDir, '20-original-plan.yml'),
        stringifyPlanWithFrontmatter({
          id: 20,
          title: 'Original Plan',
          goal: 'Test original goal',
          details: 'Test original details',
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        })
      );

      // Run handler directly with --cleanup option and custom title
      const command = {
        parent: {
          opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
        },
      };
      await handleAddCommand(['Custom', 'Cleanup', 'Title'], { cleanup: 20 }, command);

      // The cleanup file should be named 21-custom-cleanup-title.plan.md
      const cleanupPlanPath = path.join(tasksDir, '21-custom-cleanup-title.plan.md');
      expect(
        await fs.access(cleanupPlanPath).then(
          () => true,
          () => false
        )
      ).toBe(true);

      // Read and verify cleanup plan content
      const cleanupPlan = await readPlanFile(cleanupPlanPath);
      expect(cleanupPlan.id).toBe(21);
      expect(cleanupPlan.title).toBe('Custom Cleanup Title'); // Custom title, not default
      expect(cleanupPlan.parent).toBe(20);
      expect(cleanupPlan.status).toBe('pending');

      // Read and verify parent plan was updated with dependency
      const parentPlanPath = path.join(tasksDir, '20-original-plan.yml');
      const parentPlan = await readPlanFile(parentPlanPath);
      expect(parentPlan.dependencies).toEqual([21]);
    });

    test('aggregates changedFiles from parent and done child plans into rmfilter', async () => {
      // Create a parent plan with changedFiles
      const schemaLine =
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';

      await fs.writeFile(
        path.join(tasksDir, '30-parent-with-files.yml'),
        stringifyPlanWithFrontmatter({
          id: 30,
          title: 'Parent With Files',
          goal: 'Test parent goal',
          details: 'Test parent details',
          status: 'pending',
          changedFiles: ['src/file1.ts', 'src/file2.ts', 'shared.ts'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        })
      );

      // Create a child plan of the parent with status "done" and its own changedFiles
      await fs.writeFile(
        path.join(tasksDir, '31-done-child.yml'),
        stringifyPlanWithFrontmatter({
          id: 31,
          title: 'Done Child Plan',
          goal: 'Test child goal',
          details: 'Test child details',
          status: 'done',
          parent: 30,
          changedFiles: ['src/file3.ts', 'shared.ts', 'test/file.test.ts'], // shared.ts is duplicate
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        })
      );

      // Create another child plan with status "pending" (should be ignored)
      await fs.writeFile(
        path.join(tasksDir, '32-pending-child.yml'),
        stringifyPlanWithFrontmatter({
          id: 32,
          title: 'Pending Child Plan',
          goal: 'Test pending child goal',
          details: 'Test pending child details',
          status: 'pending',
          parent: 30,
          changedFiles: ['src/ignored.ts'], // Should not be included
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        })
      );

      // Run handler directly with --cleanup option
      const command = {
        parent: {
          opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
        },
      };
      await handleAddCommand([], { cleanup: 30 }, command);

      // The cleanup file should be named 33-parent-with-files-cleanup.plan.md
      const cleanupPlanPath = path.join(tasksDir, '33-parent-with-files-cleanup.plan.md');
      expect(
        await fs.access(cleanupPlanPath).then(
          () => true,
          () => false
        )
      ).toBe(true);

      // Read and verify cleanup plan content
      const cleanupPlan = await readPlanFile(cleanupPlanPath);
      expect(cleanupPlan.id).toBe(33);
      expect(cleanupPlan.title).toBe('Parent With Files - Cleanup');
      expect(cleanupPlan.parent).toBe(30);

      // Verify rmfilter contains files from parent and done child (deduplicated and sorted)
      expect(cleanupPlan.rmfilter).toEqual([
        'shared.ts',
        'src/file1.ts',
        'src/file2.ts',
        'src/file3.ts',
        'test/file.test.ts',
      ]);

      // Read and verify parent plan was updated with dependency
      const parentPlanPath = path.join(tasksDir, '30-parent-with-files.yml');
      const parentPlan = await readPlanFile(parentPlanPath);
      expect(parentPlan.dependencies).toEqual([33]);
    });

    test('errors when referencing non-existent plan ID', async () => {
      // Run handler directly with non-existent cleanup plan ID
      const command = {
        parent: {
          opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
        },
      };
      await expect(handleAddCommand([], { cleanup: 999 }, command)).rejects.toThrow(
        'Plan with ID 999 not found'
      );
    });

    test('changes referenced plan status from done to in_progress when adding cleanup dependency', async () => {
      // Create a parent plan with status "done"
      const schemaLine =
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';

      const parentCreatedAt = new Date().toISOString();
      await fs.writeFile(
        path.join(tasksDir, '40-done-plan.yml'),
        stringifyPlanWithFrontmatter({
          id: 40,
          title: 'Done Plan',
          goal: 'Test done plan goal',
          details: 'Test done plan details',
          status: 'done',
          createdAt: parentCreatedAt,
          updatedAt: parentCreatedAt,
          tasks: [],
        })
      );

      // Add a small delay to ensure timestamps are different
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Run handler directly with --cleanup option
      const command = {
        parent: {
          opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
        },
      };
      await handleAddCommand([], { cleanup: 40 }, command);

      // The cleanup file should be named 41-done-plan-cleanup.plan.md
      const cleanupPlanPath = path.join(tasksDir, '41-done-plan-cleanup.plan.md');
      expect(
        await fs.access(cleanupPlanPath).then(
          () => true,
          () => false
        )
      ).toBe(true);

      // Read and verify cleanup plan content
      const cleanupPlan = await readPlanFile(cleanupPlanPath);
      expect(cleanupPlan.id).toBe(41);
      expect(cleanupPlan.title).toBe('Done Plan - Cleanup');
      expect(cleanupPlan.parent).toBe(40);
      expect(cleanupPlan.status).toBe('pending');

      // Read and verify parent plan was updated
      const parentPlanPath = path.join(tasksDir, '40-done-plan.yml');
      const parentPlan = await readPlanFile(parentPlanPath);
      expect(parentPlan.dependencies).toEqual([41]);
      expect(parentPlan.status).toBe('in_progress'); // Changed from 'done'
      expect(new Date(parentPlan.updatedAt!).getTime()).toBeGreaterThan(
        new Date(parentCreatedAt).getTime()
      );
    });
  });

  test('creates plan with temp flag set to true', async () => {
    // Run handler directly with --temp option
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['Temporary', 'Plan'], { temp: true }, command);

    // The file should be named 1-temporary-plan.plan.md
    const planPath = path.join(tasksDir, '1-temporary-plan.plan.md');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const plan = await readPlanFile(planPath);
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('Temporary Plan');
    expect(plan.temp).toBe(true);
  });

  test('creates plan with epic flag set to true', async () => {
    // Run handler directly with --epic option
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['Epic', 'Plan'], { epic: true }, command);

    // The file should be named 1-epic-plan.plan.md
    const planPath = path.join(tasksDir, '1-epic-plan.plan.md');
    expect(
      await fs.access(planPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Read and verify plan content
    const plan = await readPlanFile(planPath);
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('Epic Plan');
    expect(plan.epic).toBe(true);
  });

  test('creates sanitized external plan when remote contains credentials and query tokens', async () => {
    clearAllTimCaches();

    const fakeHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-add-home-'));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-add-repo-'));
    const originalCwd = process.cwd();
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(fakeHomeDir, '.config');

    const remote =
      'https://user:super-secret-token@github.example.com/Owner/Repo.git?token=abc#frag';

    const realOs = await import('node:os');
    await moduleMocker.mock('node:os', () => ({
      ...realOs,
      homedir: () => fakeHomeDir,
    }));

    const logMessages: string[] = [];
    await moduleMocker.mock('../../logging.js', () => ({
      debugLog: mock(() => {}),
      error: mock(() => {}),
      log: mock((message: string) => {
        logMessages.push(message);
      }),
      warn: mock(() => {}),
    }));

    try {
      await $`git init`.cwd(repoDir).quiet();
      await $`git remote add origin ${remote}`.cwd(repoDir).quiet();

      process.chdir(repoDir);

      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleAddCommand(['External', 'Plan'], {}, command);

      const repositoryDir = path.join(
        fakeHomeDir,
        '.config',
        'tim',
        'repositories',
        'github.example.com__Owner__Repo'
      );
      const tasksDirectory = path.join(repositoryDir, 'tasks');
      const planPath = path.join(tasksDirectory, '1-external-plan.plan.md');

      const planExists = await fs
        .access(planPath)
        .then(() => true)
        .catch(() => false);

      expect(planExists).toBe(true);
      expect(repositoryDir.includes('token')).toBe(false);
      expect(tasksDirectory.includes('token')).toBe(false);
      // Verify no credentials leaked into any log messages
      expect(logMessages.some((message) => /super-secret-token|token=abc/.test(message))).toBe(
        false
      );
    } finally {
      if (originalXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
      }
      process.chdir(originalCwd);
      await fs.rm(repoDir, { recursive: true, force: true });
      await fs.rm(fakeHomeDir, { recursive: true, force: true });
      clearAllTimCaches();
    }
  });

  test('creates plan with normalized initial tags', async () => {
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };

    await handleAddCommand(['Tagged', 'Plan'], { tag: ['Frontend', 'Bug', 'frontend'] }, command);

    const planPath = path.join(tasksDir, '1-tagged-plan.plan.md');
    const plan = await readPlanFile(planPath);
    expect(plan.tags).toEqual(['bug', 'frontend']);
  });

  test('rejects initial tags not in allowlist', async () => {
    const configPath = path.join(tempDir, '.rmfilter', 'tim.yml');
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: { tasks: tasksDir },
        tags: { allowed: ['frontend'] },
      })
    );
    clearAllTimCaches();

    const command = {
      parent: {
        opts: () => ({ config: configPath }),
      },
    };

    await expect(
      handleAddCommand(['Tagged', 'Plan'], { tag: ['backend'] }, command)
    ).rejects.toThrow(/Invalid tag/);
  });

  test('creates plan with discoveredFrom reference', async () => {
    // Create the source plan
    await fs.writeFile(
      path.join(tasksDir, '1-source-plan.yml'),
      stringifyPlanWithFrontmatter({
        id: 1,
        title: 'Source Plan',
        goal: 'Source goal',
        details: 'Source details',
        status: 'in_progress',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['Discovered', 'Plan'], { discoveredFrom: 1 }, command);

    const planPath = path.join(tasksDir, '2-discovered-plan.plan.md');
    const plan = await readPlanFile(planPath);
    expect(plan.discoveredFrom).toBe(1);
    // Reference to discoveredFrom should be populated
    expect(plan.references).toBeDefined();
    expect(plan.references![1]).toMatch(UUID_REGEX);

    // Source plan should have a UUID generated
    const sourcePlan = await readPlanFile(path.join(tasksDir, '1-source-plan.yml'));
    expect(sourcePlan.uuid).toMatch(UUID_REGEX);
    expect(plan.references![1]).toBe(sourcePlan.uuid);
  });

  test('creates plan with both parent and dependsOn references', async () => {
    // Create parent plan
    const parentUuid = crypto.randomUUID();
    await fs.writeFile(
      path.join(tasksDir, '1-parent.yml'),
      stringifyPlanWithFrontmatter({
        id: 1,
        uuid: parentUuid,
        title: 'Parent',
        goal: 'Parent goal',
        details: '',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );

    // Create dependency plan (without UUID to test generation)
    await fs.writeFile(
      path.join(tasksDir, '2-dep.yml'),
      stringifyPlanWithFrontmatter({
        id: 2,
        title: 'Dependency',
        goal: 'Dep goal',
        details: '',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['Child', 'Plan'], { parent: 1, dependsOn: [2] }, command);

    const childPath = path.join(tasksDir, '3-child-plan.plan.md');
    const childPlan = await readPlanFile(childPath);
    expect(childPlan.parent).toBe(1);
    expect(childPlan.dependencies).toEqual([2]);

    // Child should have references to both parent and dependency
    expect(childPlan.references).toBeDefined();
    expect(childPlan.references![1]).toBe(parentUuid);
    expect(childPlan.references![2]).toMatch(UUID_REGEX);

    // Parent should have reference to child
    const parentPlan = await readPlanFile(path.join(tasksDir, '1-parent.yml'));
    expect(parentPlan.references![3]).toBe(childPlan.uuid);
    expect(parentPlan.uuid).toBe(parentUuid);

    // Dependency plan should have a UUID generated
    const depPlan = await readPlanFile(path.join(tasksDir, '2-dep.yml'));
    expect(depPlan.uuid).toMatch(UUID_REGEX);
    expect(childPlan.references![2]).toBe(depPlan.uuid);
  });
});
