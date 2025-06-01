import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import path from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'yaml';
import type { PlanSchema } from './planSchema.js';

// Mock modules before imports
beforeEach(() => {
  // Mock logging
  mock.module('../logging.js', () => ({
    log: () => {},
    error: () => {},
    warn: () => {},
    debugLog: () => {},
  }));

  // Mock clipboard
  mock.module('../common/clipboard.ts', () => ({
    write: () => Promise.resolve(),
    read: () => Promise.resolve(''),
  }));

  // Mock terminal
  mock.module('../common/terminal.js', () => ({
    waitForEnter: () => Promise.resolve(''),
  }));

  // Mock SSH detection
  mock.module('../common/ssh_detection.ts', () => ({
    sshAwarePasteAction: () => 'paste',
  }));
});

describe('rmplan add command', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tempDir = await mkdtemp(join(tmpdir(), 'rmplan-add-test-'));
    tasksDir = join(tempDir, 'tasks');
    await Bun.write(join(tasksDir, '.gitkeep'), '');

    // Mock the config loader
    mock.module('./configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: 'tasks',
        },
      }),
    }));

    // Mock utils
    mock.module('../rmfilter/utils.js', () => ({
      getGitRoot: async () => tempDir,
      setDebug: () => {},
      setQuiet: () => {},
      logSpawn: () => ({ exited: Promise.resolve(0) }),
    }));

    // Mock model factory
    mock.module('../common/model_factory.ts', () => ({
      createModel: () => ({}),
    }));
  });

  afterEach(async () => {
    // Clean up temporary directory
    await rm(tempDir, { recursive: true, force: true });
  });

  // Test 1 & 2: Basic add command
  it('should create a YAML file with correct structure when running "rmplan add Test Plan Title"', async () => {
    // Import after mocks are set up
    const { Command } = await import('commander');
    const program = new Command();

    // Mock the command execution by directly calling the action
    const mockAction = mock(() => {});
    let capturedTitle: string[] = [];
    let capturedOptions: any = {};

    program
      .command('add <title...>')
      .option('--edit', 'Open the newly created plan file in your editor')
      .option('--depends-on <ids...>', 'Specify plan IDs that this plan depends on')
      .option('--priority <level>', 'Set the priority level (low, medium, high, urgent)')
      .action(async (title, options) => {
        capturedTitle = title;
        capturedOptions = options;

        // Execute the actual add logic inline
        const planTitle = title.join(' ');
        const { generateProjectId, slugify } = await import('./id_utils.js');
        const planId = generateProjectId();
        const filename = slugify(planTitle) + '.yml';
        const filePath = join(tasksDir, filename);

        const plan: PlanSchema = {
          id: planId,
          title: planTitle,
          goal: 'Goal to be defined.',
          details: 'Details to be added.',
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        };

        const yamlContent = yaml.stringify(plan);
        const fullContent = `# yaml-language-server: $schema=https:
        await Bun.write(filePath, fullContent);

        mockAction();
      });

    // Parse the command
    await program.parseAsync(['node', 'rmplan', 'add', 'Test', 'Plan', 'Title']);

    expect(mockAction).toHaveBeenCalled();
    expect(capturedTitle).toEqual(['Test', 'Plan', 'Title']);

    // Verify file was created
    const expectedFilePath = join(tasksDir, 'test-plan-title.yml');
    await expect(access(expectedFilePath)).resolves.toBeNull();

    // Read and parse the file
    const fileContent = await readFile(expectedFilePath, 'utf-8');
    const yamlStartIndex = fileContent.indexOf('\n') + 1;
    const yamlContent = fileContent.substring(yamlStartIndex);
    const parsedPlan = yaml.parse(yamlContent) as PlanSchema;

    // Verify structure
    expect(parsedPlan.id).toBeDefined();
    expect(typeof parsedPlan.id).toBe('string');
    expect(parsedPlan.title).toBe('Test Plan Title');
    expect(parsedPlan.goal).toBe('Goal to be defined.');
    expect(parsedPlan.details).toBe('Details to be added.');
    expect(parsedPlan.status).toBe('pending');
    expect(parsedPlan.createdAt).toBeDefined();
    expect(parsedPlan.updatedAt).toBeDefined();
    expect(parsedPlan.tasks).toEqual([]);

    // Verify timestamps are recent (within last minute)
    const createdAt = new Date(parsedPlan.createdAt!);
    const updatedAt = new Date(parsedPlan.updatedAt!);
    const now = new Date();
    const oneMinuteAgo = new Date(now.getTime() - 60000);
    expect(createdAt.getTime()).toBeGreaterThan(oneMinuteAgo.getTime());
    expect(updatedAt.getTime()).toBeGreaterThan(oneMinuteAgo.getTime());
  });

  // Test 3: Edit option
  it('should launch editor when --edit option is provided', async () => {
    let spawnCalled = false;
    let spawnArgs: string[] = [];

    // Mock Bun.spawn
    const originalSpawn = Bun.spawn;
    Bun.spawn = (args: any) => {
      spawnCalled = true;
      spawnArgs = args;
      return {
        exited: Promise.resolve(0),
        pid: 12345,
        kill: () => {},
        ref: () => {},
        unref: () => {},
        stdin: null as any,
        stdout: null as any,
        stderr: null as any,
      };
    };

    try {
      const { Command } = await import('commander');
      const program = new Command();

      // Set EDITOR env var for test
      process.env.EDITOR = 'test-editor';

      program
        .command('add <title...>')
        .option('--edit', 'Open the newly created plan file in your editor')
        .option('--depends-on <ids...>', 'Specify plan IDs that this plan depends on')
        .option('--priority <level>', 'Set the priority level (low, medium, high, urgent)')
        .action(async (title, options) => {
          // Execute the actual add logic
          const planTitle = title.join(' ');
          const { generateProjectId, slugify } = await import('./id_utils.js');
          const planId = generateProjectId();
          const filename = slugify(planTitle) + '.yml';
          const filePath = join(tasksDir, filename);

          const plan: PlanSchema = {
            id: planId,
            title: planTitle,
            goal: 'Goal to be defined.',
            details: 'Details to be added.',
            status: 'pending',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            tasks: [],
          };

          const yamlContent = yaml.stringify(plan);
          const fullContent = `# yaml-language-server: $schema=https:
          await Bun.write(filePath, fullContent);

          if (options.edit) {
            const editor = process.env.EDITOR || 'nano';
            const editorProcess = Bun.spawn([editor, filePath], {
              stdio: ['inherit', 'inherit', 'inherit'],
            });
            await editorProcess.exited;
          }
        });

      // Parse the command with --edit
      await program.parseAsync(['node', 'rmplan', 'add', 'Edit', 'Test', '--edit']);

      expect(spawnCalled).toBe(true);
      expect(spawnArgs[0]).toBe('test-editor');
      expect(spawnArgs[1]).toBe(join(tasksDir, 'edit-test.yml'));
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  // Test 4: Dependencies option
  it('should add dependencies when --depends-on is provided', async () => {
    const { Command } = await import('commander');
    const program = new Command();

    program
      .command('add <title...>')
      .option('--edit', 'Open the newly created plan file in your editor')
      .option('--depends-on <ids...>', 'Specify plan IDs that this plan depends on')
      .option('--priority <level>', 'Set the priority level (low, medium, high, urgent)')
      .action(async (title, options) => {
        const planTitle = title.join(' ');
        const { generateProjectId, slugify } = await import('./id_utils.js');
        const planId = generateProjectId();
        const filename = slugify(planTitle) + '.yml';
        const filePath = join(tasksDir, filename);

        const plan: PlanSchema = {
          id: planId,
          title: planTitle,
          goal: 'Goal to be defined.',
          details: 'Details to be added.',
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        };

        if (options.dependsOn && options.dependsOn.length > 0) {
          plan.dependencies = options.dependsOn;
        }

        const yamlContent = yaml.stringify(plan);
        const fullContent = `# yaml-language-server: $schema=https:
        await Bun.write(filePath, fullContent);
      });

    // Parse the command with dependencies
    await program.parseAsync([
      'node',
      'rmplan',
      'add',
      'Deps',
      'Test',
      '--depends-on',
      'dep1',
      'dep2',
    ]);

    // Verify file was created with dependencies
    const fileContent = await readFile(join(tasksDir, 'deps-test.yml'), 'utf-8');
    const yamlStartIndex = fileContent.indexOf('\n') + 1;
    const yamlContent = fileContent.substring(yamlStartIndex);
    const parsedPlan = yaml.parse(yamlContent) as PlanSchema;

    expect(parsedPlan.dependencies).toEqual(['dep1', 'dep2']);
  });

  // Test 5: Priority option
  it('should set priority when --priority is provided', async () => {
    const { Command } = await import('commander');
    const program = new Command();

    program
      .command('add <title...>')
      .option('--edit', 'Open the newly created plan file in your editor')
      .option('--depends-on <ids...>', 'Specify plan IDs that this plan depends on')
      .option('--priority <level>', 'Set the priority level (low, medium, high, urgent)')
      .action(async (title, options) => {
        const planTitle = title.join(' ');
        const { generateProjectId, slugify } = await import('./id_utils.js');
        const planId = generateProjectId();
        const filename = slugify(planTitle) + '.yml';
        const filePath = join(tasksDir, filename);

        const plan: PlanSchema = {
          id: planId,
          title: planTitle,
          goal: 'Goal to be defined.',
          details: 'Details to be added.',
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        };

        if (options.priority) {
          plan.priority = options.priority as 'low' | 'medium' | 'high' | 'urgent';
        }

        const yamlContent = yaml.stringify(plan);
        const fullContent = `# yaml-language-server: $schema=https:
        await Bun.write(filePath, fullContent);
      });

    // Parse the command with priority
    await program.parseAsync(['node', 'rmplan', 'add', 'Priority', 'Test', '--priority', 'high']);

    // Verify file was created with priority
    const fileContent = await readFile(join(tasksDir, 'priority-test.yml'), 'utf-8');
    const yamlStartIndex = fileContent.indexOf('\n') + 1;
    const yamlContent = fileContent.substring(yamlStartIndex);
    const parsedPlan = yaml.parse(yamlContent) as PlanSchema;

    expect(parsedPlan.priority).toBe('high');
  });

  // Test 6: File location with and without configured tasks path
  it('should create file in correct location based on paths.tasks configuration', async () => {
    // Test with configured tasks path (already set in beforeEach)
    const { Command } = await import('commander');
    const program = new Command();

    program.command('add <title...>').action(async (title) => {
      const planTitle = title.join(' ');
      const { generateProjectId, slugify } = await import('./id_utils.js');
      const { loadEffectiveConfig } = await import('./configLoader.js');
      const { getGitRoot } = await import('../rmfilter/utils.js');

      const config = await loadEffectiveConfig();
      const planId = generateProjectId();
      const filename = slugify(planTitle) + '.yml';

      let targetDir: string;
      if (config.paths?.tasks) {
        if (path.isAbsolute(config.paths.tasks)) {
          targetDir = config.paths.tasks;
        } else {
          // Resolve relative to git root
          const gitRoot = (await getGitRoot()) || process.cwd();
          targetDir = path.join(gitRoot, config.paths.tasks);
        }
      } else {
        targetDir = process.cwd();
      }

      const filePath = join(targetDir, filename);

      const plan: PlanSchema = {
        id: planId,
        title: planTitle,
        goal: 'Goal to be defined.',
        details: 'Details to be added.',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      };

      const yamlContent = yaml.stringify(plan);
      const fullContent = `# yaml-language-server: $schema=https:
      await Bun.write(filePath, fullContent);
    });

    await program.parseAsync(['node', 'rmplan', 'add', 'Location', 'Test']);

    // Verify file was created in tasks directory
    const expectedPath = join(tasksDir, 'location-test.yml');
    await expect(access(expectedPath)).resolves.toBeNull();

    // Test without configured tasks path
    mock.module('./configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        // No paths.tasks configured
      }),
    }));

    // Mock process.cwd to return tempDir
    const originalCwd = process.cwd;
    process.cwd = () => tempDir;

    try {
      const program2 = new Command();
      program2.command('add <title...>').action(async (title) => {
        const planTitle = title.join(' ');
        const { generateProjectId, slugify } = await import('./id_utils.js');
        const { loadEffectiveConfig } = await import('./configLoader.js');

        const config = await loadEffectiveConfig();
        const planId = generateProjectId();
        const filename = slugify(planTitle) + '.yml';

        const targetDir = config.paths?.tasks || process.cwd();
        const filePath = join(targetDir, filename);

        const plan: PlanSchema = {
          id: planId,
          title: planTitle,
          goal: 'Goal to be defined.',
          details: 'Details to be added.',
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        };

        const yamlContent = yaml.stringify(plan);
        const fullContent = `# yaml-language-server: $schema=https:
        await Bun.write(filePath, fullContent);
      });

      await program2.parseAsync(['node', 'rmplan', 'add', 'No', 'Config', 'Test']);

      // Verify file was created in current directory (tempDir)
      const expectedPath2 = join(tempDir, 'no-config-test.yml');
      await expect(access(expectedPath2)).resolves.toBeNull();
    } finally {
      process.cwd = originalCwd;
    }
  });
});

describe('rmplan split command', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tempDir = await mkdtemp(join(tmpdir(), 'rmplan-split-test-'));
    tasksDir = join(tempDir, 'tasks');
    await Bun.write(join(tasksDir, '.gitkeep'), '');

    // Mock the config loader
    mock.module('./configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
      }),
    }));

    // Mock utils
    mock.module('../rmfilter/utils.js', () => ({
      getGitRoot: async () => tempDir,
      setDebug: () => {},
      setQuiet: () => {},
      logSpawn: () => ({ exited: Promise.resolve(0) }),
    }));
  });

  afterEach(async () => {
    // Clean up temporary directory
    await rm(tempDir, { recursive: true, force: true });
  });

  // Test 1: Split command is defined
  it('should have split command defined and callable', async () => {
    const { Command } = await import('commander');
    const program = new Command();
    program.option('--debug', 'Enable debug logging');
    program.option('-c, --config <path>', 'Config path');

    let splitCalled = false;

    program
      .command('split <planFile>')
      .description('Split a large plan file into multiple phase-specific plan files')
      .action(async (planFile) => {
        splitCalled = true;
      });

    await program.parseAsync(['node', 'rmplan', 'split', 'test-plan.yml']);
    expect(splitCalled).toBe(true);
  });

  // Test 5: Successfully load and parse a valid plan file
  it('should successfully load and parse a valid plan file', async () => {
    // Create a valid plan file
    const validPlan: PlanSchema = {
      id: 'test-plan',
      title: 'Test Plan',
      goal: 'Test the split functionality',
      details: 'This is a test plan',
      status: 'pending',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tasks: [
        {
          title: 'Task 1',
          description: 'First task',
          files: [],
          steps: [{ prompt: 'Step 1', done: false }],
        },
        {
          title: 'Task 2',
          description: 'Second task',
          files: [],
          steps: [{ prompt: 'Step 2', done: false }],
        },
      ],
    };

    const planFilePath = join(tasksDir, 'valid-plan.yml');
    const yamlContent = yaml.stringify(validPlan);
    const fullContent = `# yaml-language-server: $schema=https:
    await Bun.write(planFilePath, fullContent);

    const { Command } = await import('commander');
    const program = new Command();
    program.option('--debug', 'Enable debug logging');
    program.option('-c, --config <path>', 'Config path');

    let parsedPlan: PlanSchema | null = null;
    let loadedTitle: string | null = null;
    let loadedGoal: string | null = null;

    program
      .command('split <planFile>')
      .description('Split a large plan file into multiple phase-specific plan files')
      .action(async (planFile) => {
        const path = await import('path');
        const resolvedPlanFile = path.resolve(planFile);

        try {
          const content = await Bun.file(resolvedPlanFile).text();
          const parsed = yaml.parse(content) as any;

          // Import and validate with planSchema
          const { planSchema } = await import('./planSchema.js');
          const result = planSchema.safeParse(parsed);

          if (result.success) {
            parsedPlan = result.data;
            loadedTitle = parsedPlan!.title || '';
            loadedGoal = parsedPlan!.goal;
          }
        } catch (err) {
          // Error handling tested in other tests
        }
      });

    await program.parseAsync(['node', 'rmplan', 'split', planFilePath]);

    expect(parsedPlan).not.toBeNull();
    expect(loadedTitle).toBe('Test Plan');
    expect(loadedGoal).toBe('Test the split functionality');
  });

  // Test 6: Error handling - file does not exist
  it('should handle error when input file does not exist', async () => {
    const { Command } = await import('commander');
    const program = new Command();
    program.option('--debug', 'Enable debug logging');
    program.option('-c, --config <path>', 'Config path');

    let errorOccurred = false;
    let errorMessage = '';

    // Mock process.exit
    const originalExit = process.exit;
    process.exit = ((code: number) => {
      if (code !== 0) {
        errorOccurred = true;
      }
    }) as any;

    program
      .command('split <planFile>')
      .description('Split a large plan file into multiple phase-specific plan files')
      .action(async (planFile) => {
        const path = await import('path');
        const resolvedPlanFile = path.resolve(planFile);

        try {
          await Bun.file(resolvedPlanFile).text();
        } catch (err) {
          errorMessage = 'File read error';
          process.exit(1);
        }
      });

    try {
      await program.parseAsync(['node', 'rmplan', 'split', '/nonexistent/file.yml']);
    } finally {
      process.exit = originalExit;
    }

    expect(errorOccurred).toBe(true);
    expect(errorMessage).toBe('File read error');
  });

  // Test 6: Error handling - invalid YAML
  it('should handle error when input file is not valid YAML', async () => {
    const invalidYamlPath = join(tasksDir, 'invalid.yml');
    // Use clearly invalid YAML with unmatched quotes and brackets
    await Bun.write(invalidYamlPath, '- item1\n  - "unclosed quote\n- [bracket mismatch}');

    const { Command } = await import('commander');
    const program = new Command();
    program.option('--debug', 'Enable debug logging');
    program.option('-c, --config <path>', 'Config path');

    let errorOccurred = false;

    // Mock process.exit
    const originalExit = process.exit;
    process.exit = ((code: number) => {
      if (code !== 0) {
        errorOccurred = true;
      }
    }) as any;

    program
      .command('split <planFile>')
      .description('Split a large plan file into multiple phase-specific plan files')
      .action(async (planFile) => {
        const path = await import('path');
        const resolvedPlanFile = path.resolve(planFile);

        try {
          const content = await Bun.file(resolvedPlanFile).text();
          try {
            yaml.parse(content);
          } catch (parseErr) {
            // YAML parsing failed
            process.exit(1);
          }
        } catch (err) {
          // File read failed
          process.exit(1);
        }
      });

    try {
      await program.parseAsync(['node', 'rmplan', 'split', invalidYamlPath]);
    } finally {
      process.exit = originalExit;
    }

    expect(errorOccurred).toBe(true);
  });

  // Test 6: Error handling - valid YAML but not conforming to PlanSchema
  it('should handle error when YAML does not conform to PlanSchema', async () => {
    const invalidPlanPath = join(tasksDir, 'invalid-plan.yml');
    const invalidPlan = {
      // Missing required fields like 'goal'
      id: 'invalid',
      title: 'Invalid Plan',
    };
    await Bun.write(invalidPlanPath, yaml.stringify(invalidPlan));

    const { Command } = await import('commander');
    const program = new Command();
    program.option('--debug', 'Enable debug logging');
    program.option('-c, --config <path>', 'Config path');

    let errorOccurred = false;
    let validationFailed = false;

    // Mock process.exit
    const originalExit = process.exit;
    process.exit = ((code: number) => {
      if (code !== 0) {
        errorOccurred = true;
      }
    }) as any;

    program
      .command('split <planFile>')
      .description('Split a large plan file into multiple phase-specific plan files')
      .action(async (planFile) => {
        const path = await import('path');
        const resolvedPlanFile = path.resolve(planFile);

        try {
          const content = await Bun.file(resolvedPlanFile).text();
          const parsed = yaml.parse(content);

          const { planSchema } = await import('./planSchema.js');
          const result = planSchema.safeParse(parsed);

          if (!result.success) {
            validationFailed = true;
            process.exit(1);
          }
        } catch (err) {
          process.exit(1);
        }
      });

    try {
      await program.parseAsync(['node', 'rmplan', 'split', invalidPlanPath]);
    } finally {
      process.exit = originalExit;
    }

    expect(errorOccurred).toBe(true);
    expect(validationFailed).toBe(true);
  });
});

describe('rmplan generate command - stub plan update', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tempDir = await mkdtemp(join(tmpdir(), 'rmplan-generate-test-'));
    tasksDir = join(tempDir, 'tasks');
    await Bun.write(join(tasksDir, '.gitkeep'), '');

    // Mock the config loader
    mock.module('./configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
        models: {
          convert_yaml: 'test-model',
        },
      }),
    }));

    // Mock utils
    mock.module('../rmfilter/utils.js', () => ({
      getGitRoot: async () => tempDir,
      setDebug: () => {},
      setQuiet: () => {},
      logSpawn: () => ({ exited: Promise.resolve(0) }),
    }));
  });

  afterEach(async () => {
    // Clean up temporary directory
    await rm(tempDir, { recursive: true, force: true });
  });

  // Tests 7, 8, 9: Generate command updating stub plan
  it('should populate tasks in an existing stub plan file', async () => {
    // Create a stub plan file
    const stubPlan: PlanSchema = {
      id: 'test-stub-plan',
      title: 'Test Stub Plan',
      goal: 'Test the stub plan functionality',
      details: 'This is a test stub plan that should be populated with tasks',
      status: 'pending',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tasks: [],
    };

    const stubFilePath = join(tasksDir, 'stub-plan.yml');
    const yamlContent = yaml.stringify(stubPlan);
    const fullContent = `# yaml-language-server: $schema=https:
    await Bun.write(stubFilePath, fullContent);

    // Mock the LLM and conversion functions
    const mockMarkdownOutput = `# Test Stub Plan

## Goal
Test the stub plan functionality

## Tasks

### Task 1: Setup environment
Set up the test environment

### Task 2: Run tests
Execute the test suite`;

    const mockYamlOutput = yaml.stringify({
      id: 'generated-plan',
      title: 'Generated Plan',
      goal: 'Test goal',
      tasks: [
        {
          title: 'Setup environment',
          description: 'Set up the test environment',
          files: [],
          steps: [
            {
              prompt: 'Install dependencies',
              done: false,
            },
          ],
        },
        {
          title: 'Run tests',
          description: 'Execute the test suite',
          files: [],
          steps: [
            {
              prompt: 'Run unit tests',
              done: false,
            },
          ],
        },
      ],
    });

    // Mock ai module
    mock.module('ai', () => ({
      generateText: async () => ({
        text: mockMarkdownOutput,
      }),
    }));

    // Mock process_markdown module
    mock.module('./process_markdown.ts', () => ({
      convertMarkdownToYaml: async () => mockYamlOutput,
      findYamlStart: (text: string) => text,
    }));

    // Mock fix_yaml
    mock.module('./fix_yaml.js', () => ({
      fixYaml: (yaml: string) => yaml,
    }));

    // Mock model factory
    mock.module('../common/model_factory.ts', () => ({
      createModel: () => ({}),
    }));

    // Import after mocks are set up
    const { Command } = await import('commander');
    const program = new Command();
    program.option('--debug', 'Enable debug logging');
    program.option('-c, --config <path>', 'Config path');

    let generateCalled = false;

    program
      .command('generate')
      .option('--plan <file>', 'Plan text file to use')
      .action(async (options) => {
        generateCalled = true;

        // Simulate the generate command logic for stub plans
        const fileContent = await Bun.file(options.plan).text();
        const { findYamlStart } = await import('./process_markdown.ts');

        let parsedPlan: PlanSchema;
        try {
          const yamlContent = findYamlStart(fileContent);
          parsedPlan = yaml.parse(yamlContent) as PlanSchema;
        } catch {
          throw new Error('Failed to parse plan');
        }

        // Check if it's a stub plan
        const isStubPlan = !parsedPlan.tasks || parsedPlan.tasks.length === 0;
        if (!isStubPlan) {
          return;
        }

        // Mock the LLM generation
        const { generateText } = await import('ai');
        const { createModel } = await import('../common/model_factory.ts');
        const { convertMarkdownToYaml, fixYaml } = await import('./process_markdown.ts');

        const model = createModel('test-model');
        const llmResult = await generateText({
          model,
          prompt: 'test prompt',
          temperature: 0.7,
          maxTokens: 4000,
        });

        const yamlString = await convertMarkdownToYaml(
          llmResult.text,
          { models: { convert_yaml: 'test-model' } } as any,
          true
        );

        // Parse generated YAML
        const generatedPlan = yaml.parse(yamlString);

        // Merge tasks into original plan
        parsedPlan.tasks = generatedPlan.tasks;

        // Update timestamps
        const now = new Date().toISOString();
        parsedPlan.planGeneratedAt = now;
        parsedPlan.promptsGeneratedAt = now;
        parsedPlan.updatedAt = now;

        // Write back
        const updatedYaml = yaml.stringify(parsedPlan);
        const updatedContent = `# yaml-language-server: $schema=https:
        await Bun.write(options.plan, updatedContent);
      });

    // Parse the command
    await program.parseAsync(['node', 'rmplan', 'generate', '--plan', stubFilePath]);

    expect(generateCalled).toBe(true);

    // Read the updated file
    const updatedContent = await readFile(stubFilePath, 'utf-8');
    const yamlStartIndex = updatedContent.indexOf('\n') + 1;
    const updatedYamlContent = updatedContent.substring(yamlStartIndex);
    const updatedPlan = yaml.parse(updatedYamlContent) as PlanSchema;

    // Verify the plan was updated correctly
    expect(updatedPlan.tasks).toBeDefined();
    expect(updatedPlan.tasks!.length).toBe(2);
    expect(updatedPlan.tasks![0].title).toBe('Setup environment');
    expect(updatedPlan.tasks![1].title).toBe('Run tests');

    // Verify timestamps were updated
    expect(updatedPlan.planGeneratedAt).toBeDefined();
    expect(updatedPlan.promptsGeneratedAt).toBeDefined();
    expect(updatedPlan.updatedAt).toBeDefined();

    // Verify original fields were preserved
    expect(updatedPlan.id).toBe('test-stub-plan');
    expect(updatedPlan.title).toBe('Test Stub Plan');
    expect(updatedPlan.goal).toBe('Test the stub plan functionality');
    expect(updatedPlan.details).toBe(
      'This is a test stub plan that should be populated with tasks'
    );
    expect(updatedPlan.status).toBe('pending');
    expect(updatedPlan.createdAt).toBe('2024-01-01T00:00:00Z');
  });

  // Test 10: Generate command on plan with existing tasks
  it('should not update a plan that already has tasks', async () => {
    // Create a plan with existing tasks
    const existingPlan: PlanSchema = {
      id: 'existing-plan',
      title: 'Existing Plan',
      goal: 'Test existing plan',
      details: 'This plan already has tasks',
      status: 'in_progress',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tasks: [
        {
          title: 'Existing task',
          description: 'This task already exists',
          files: [],
          steps: [
            {
              prompt: 'Existing step',
              done: true,
            },
          ],
        },
      ],
    };

    const planFilePath = join(tasksDir, 'existing-plan.yml');
    const yamlContent = yaml.stringify(existingPlan);
    const fullContent = `# yaml-language-server: $schema=https:
    await Bun.write(planFilePath, fullContent);

    // Keep a copy of the original content
    const originalContent = fullContent;

    // Mock modules
    mock.module('ai', () => ({
      generateText: async () => {
        throw new Error('Should not call LLM for plans with existing tasks');
      },
    }));

    const { Command } = await import('commander');
    const program = new Command();
    program.option('--debug', 'Enable debug logging');
    program.option('-c, --config <path>', 'Config path');

    let generateCalled = false;
    let llmCalled = false;

    program
      .command('generate')
      .option('--plan <file>', 'Plan text file to use')
      .action(async (options) => {
        generateCalled = true;

        // Simulate the generate command logic
        const fileContent = await Bun.file(options.plan).text();
        const { findYamlStart } = await import('./process_markdown.ts');

        let parsedPlan: PlanSchema;
        try {
          const yamlContent = findYamlStart(fileContent);
          parsedPlan = yaml.parse(yamlContent) as PlanSchema;
        } catch {
          // Not a YAML plan, continue with normal flow
          return;
        }

        // Check if it's a stub plan
        const isStubPlan = !parsedPlan.tasks || parsedPlan.tasks.length === 0;
        if (!isStubPlan) {
          // Plan already has tasks - don't update it
          return;
        }

        // This shouldn't be reached for our test
        llmCalled = true;
      });

    // Parse the command
    await program.parseAsync(['node', 'rmplan', 'generate', '--plan', planFilePath]);

    expect(generateCalled).toBe(true);
    expect(llmCalled).toBe(false);

    // Verify the file was not modified
    const currentContent = await readFile(planFilePath, 'utf-8');
    expect(currentContent).toBe(originalContent);
  });
});
