import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleValidateCommand } from './validate.js';
import type { RmplanConfig } from '../configSchema.js';

describe('validate command', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('valid plan files', () => {
    test('should pass validation for a valid basic plan file', async () => {
      const validPlan = `---
goal: Implement user authentication
details: Add login and signup functionality
tasks:
  - title: Create login form
    description: Build the user interface for login
    files:
      - src/components/LoginForm.tsx
    steps:
      - prompt: Design the login form UI
        done: false
  - title: Implement auth service
    description: Create authentication service
    files: []
    steps: []
---

Additional plan details in markdown format.
`;

      await fs.writeFile(path.join(tempDir, 'valid.plan.md'), validPlan);

      // Mock console methods to capture output
      const originalLog = console.log;
      const originalExit = process.exit;
      let exitCode: number | undefined;
      let logOutput: string[] = [];

      console.log = (...args) => {
        logOutput.push(args.join(' '));
      };

      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      }) as never;

      try {
        await handleValidateCommand({ dir: tempDir }, { parent: { opts: () => ({}) } });
      } catch (err) {
        // Expected if process.exit is called
      } finally {
        console.log = originalLog;
        process.exit = originalExit;
      }

      expect(exitCode).toBeUndefined(); // Should not exit with error
      expect(logOutput.join('\\n')).toContain('✓ 1 valid');
      expect(logOutput.join('\\n')).not.toContain('✗');
    });

    test('should pass validation for a valid YAML-only plan file', async () => {
      const validPlan = `goal: Implement feature X
details: This is a test plan
tasks:
  - title: Task 1
    description: First task
    files: []
    steps: []
`;

      await fs.writeFile(path.join(tempDir, 'valid.yml'), validPlan);

      // Mock console methods to capture output
      const originalLog = console.log;
      const originalExit = process.exit;
      let exitCode: number | undefined;
      let logOutput: string[] = [];

      console.log = (...args) => {
        logOutput.push(args.join(' '));
      };

      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      }) as never;

      try {
        await handleValidateCommand({ dir: tempDir }, { parent: { opts: () => ({}) } });
      } catch (err) {
        // Expected if process.exit is called
      } finally {
        console.log = originalLog;
        process.exit = originalExit;
      }

      expect(exitCode).toBeUndefined(); // Should not exit with error
      expect(logOutput.join('\\n')).toContain('✓ 1 valid');
    });
  });

  describe('invalid plan files with unknown keys', () => {
    test('should detect unknown keys at root level', async () => {
      const invalidPlan = `goal: Test plan
details: Test details
unknownRootKey: invalid
tasks: []
`;

      await fs.writeFile(path.join(tempDir, 'invalid-root.yml'), invalidPlan);

      // Mock console methods to capture output
      const originalLog = console.log;
      const originalExit = process.exit;
      let exitCode: number | undefined;
      let logOutput: string[] = [];

      console.log = (...args) => {
        logOutput.push(args.join(' '));
      };

      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      }) as never;

      try {
        await handleValidateCommand({ dir: tempDir }, { parent: { opts: () => ({}) } });
      } catch (err) {
        // Expected since process.exit should be called
      } finally {
        console.log = originalLog;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1); // Should exit with error
      expect(logOutput.join('\\n')).toContain('✗ 1 invalid');
      expect(logOutput.join('\\n')).toContain('Unknown keys: unknownRootKey');
    });

    test('should detect unknown keys in tasks array', async () => {
      const invalidPlan = `goal: Test plan
details: Test details
tasks:
  - title: Task 1
    description: First task
    unknownTaskKey: invalid
    files: []
    steps: []
`;

      await fs.writeFile(path.join(tempDir, 'invalid-task.yml'), invalidPlan);

      // Mock console methods to capture output
      const originalLog = console.log;
      const originalExit = process.exit;
      let exitCode: number | undefined;
      let logOutput: string[] = [];

      console.log = (...args) => {
        logOutput.push(args.join(' '));
      };

      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      }) as never;

      try {
        await handleValidateCommand({ dir: tempDir }, { parent: { opts: () => ({}) } });
      } catch (err) {
        // Expected since process.exit should be called
      } finally {
        console.log = originalLog;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1); // Should exit with error
      expect(logOutput.join('\\n')).toContain('✗ 1 invalid');
      expect(logOutput.join('\\n')).toContain('Unknown keys: tasks.0.unknownTaskKey');
    });

    test('should detect unknown keys in steps array', async () => {
      const invalidPlan = `goal: Test plan
details: Test details
tasks:
  - title: Task 1
    description: First task
    files: []
    steps:
      - prompt: Step 1
        done: false
        unknownStepKey: invalid
`;

      await fs.writeFile(path.join(tempDir, 'invalid-step.yml'), invalidPlan);

      // Mock console methods to capture output
      const originalLog = console.log;
      const originalExit = process.exit;
      let exitCode: number | undefined;
      let logOutput: string[] = [];

      console.log = (...args) => {
        logOutput.push(args.join(' '));
      };

      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      }) as never;

      try {
        await handleValidateCommand({ dir: tempDir }, { parent: { opts: () => ({}) } });
      } catch (err) {
        // Expected since process.exit should be called
      } finally {
        console.log = originalLog;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1); // Should exit with error
      expect(logOutput.join('\\n')).toContain('✗ 1 invalid');
      expect(logOutput.join('\\n')).toContain('Unknown keys: tasks.0.steps.0.unknownStepKey');
    });

    test('should detect unknown keys in project section', async () => {
      const invalidPlan = `goal: Phase goal
details: Phase details
project:
  title: Project title
  goal: Project goal
  details: Project details
  unknownProjectKey: invalid
tasks: []
`;

      await fs.writeFile(path.join(tempDir, 'invalid-project.yml'), invalidPlan);

      // Mock console methods to capture output
      const originalLog = console.log;
      const originalExit = process.exit;
      let exitCode: number | undefined;
      let logOutput: string[] = [];

      console.log = (...args) => {
        logOutput.push(args.join(' '));
      };

      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      }) as never;

      try {
        await handleValidateCommand({ dir: tempDir }, { parent: { opts: () => ({}) } });
      } catch (err) {
        // Expected since process.exit should be called
      } finally {
        console.log = originalLog;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1); // Should exit with error
      expect(logOutput.join('\\n')).toContain('✗ 1 invalid');
      expect(logOutput.join('\\n')).toContain('Unknown keys: project.unknownProjectKey');
    });

    test('should detect multiple unknown keys at different levels', async () => {
      const invalidPlan = `goal: Test plan
details: Test details
unknownRoot1: invalid
unknownRoot2: also invalid
tasks:
  - title: Task 1
    description: First task
    unknownTask: invalid
    files: []
    steps:
      - prompt: Step 1
        done: false
        unknownStep: invalid
project:
  title: Project title
  goal: Project goal
  unknownProject: invalid
`;

      await fs.writeFile(path.join(tempDir, 'invalid-multiple.yml'), invalidPlan);

      // Mock console methods to capture output
      const originalLog = console.log;
      const originalExit = process.exit;
      let exitCode: number | undefined;
      let logOutput: string[] = [];

      console.log = (...args) => {
        logOutput.push(args.join(' '));
      };

      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      }) as never;

      try {
        await handleValidateCommand({ dir: tempDir }, { parent: { opts: () => ({}) } });
      } catch (err) {
        // Expected since process.exit should be called
      } finally {
        console.log = originalLog;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1); // Should exit with error
      const output = logOutput.join('\\n');
      expect(output).toContain('✗ 1 invalid');
      expect(output).toContain('unknownRoot1');
      expect(output).toContain('unknownRoot2');
      expect(output).toContain('tasks.0.unknownTask');
      expect(output).toContain('tasks.0.steps.0.unknownStep');
      expect(output).toContain('project.unknownProject');
    });
  });

  describe('frontmatter format validation', () => {
    test('should validate frontmatter format files correctly', async () => {
      const frontmatterPlan = `---
goal: Implement user authentication  
details: Add login and signup functionality
tasks:
  - title: Create login form
    description: Build the user interface for login
    files:
      - src/components/LoginForm.tsx
    steps:
      - prompt: Design the login form UI
        done: false
---

# Additional Markdown Content

This is additional content that should be merged with the details field.
`;

      await fs.writeFile(path.join(tempDir, 'frontmatter.plan.md'), frontmatterPlan);

      // Mock console methods to capture output
      const originalLog = console.log;
      const originalExit = process.exit;
      let exitCode: number | undefined;
      let logOutput: string[] = [];

      console.log = (...args) => {
        logOutput.push(args.join(' '));
      };

      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      }) as never;

      try {
        await handleValidateCommand({ dir: tempDir }, { parent: { opts: () => ({}) } });
      } catch (err) {
        // Expected if process.exit is called
      } finally {
        console.log = originalLog;
        process.exit = originalExit;
      }

      expect(exitCode).toBeUndefined(); // Should not exit with error
      expect(logOutput.join('\\n')).toContain('✓ 1 valid');
    });

    test('should detect unknown keys in frontmatter format files', async () => {
      const invalidFrontmatterPlan = `---
goal: Test plan
details: Test details
unknownKey: invalid
tasks: []
---

# Additional Content
`;

      await fs.writeFile(path.join(tempDir, 'invalid-frontmatter.plan.md'), invalidFrontmatterPlan);

      // Mock console methods to capture output
      const originalLog = console.log;
      const originalExit = process.exit;
      let exitCode: number | undefined;
      let logOutput: string[] = [];

      console.log = (...args) => {
        logOutput.push(args.join(' '));
      };

      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      }) as never;

      try {
        await handleValidateCommand({ dir: tempDir }, { parent: { opts: () => ({}) } });
      } catch (err) {
        // Expected since process.exit should be called
      } finally {
        console.log = originalLog;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1); // Should exit with error
      expect(logOutput.join('\\n')).toContain('✗ 1 invalid');
      expect(logOutput.join('\\n')).toContain('Unknown keys: unknownKey');
    });
  });

  describe('verbose mode', () => {
    test('should show valid files in verbose mode', async () => {
      const validPlan = `goal: Test plan
details: Test details
tasks: []
`;

      await fs.writeFile(path.join(tempDir, 'valid.yml'), validPlan);

      // Mock console methods to capture output
      const originalLog = console.log;
      const originalExit = process.exit;
      let exitCode: number | undefined;
      let logOutput: string[] = [];

      console.log = (...args) => {
        logOutput.push(args.join(' '));
      };

      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      }) as never;

      try {
        await handleValidateCommand(
          { dir: tempDir, verbose: true },
          { parent: { opts: () => ({}) } }
        );
      } catch (err) {
        // Expected if process.exit is called
      } finally {
        console.log = originalLog;
        process.exit = originalExit;
      }

      expect(exitCode).toBeUndefined(); // Should not exit with error
      const output = logOutput.join('\\n');
      expect(output).toContain('✓ Valid files:');
      expect(output).toContain('• valid.yml');
    });
  });

  describe('mixed valid and invalid files', () => {
    test('should correctly report both valid and invalid files', async () => {
      // Create a valid file
      const validPlan = `goal: Valid plan
details: Valid details
tasks: []
`;
      await fs.writeFile(path.join(tempDir, 'valid.yml'), validPlan);

      // Create an invalid file
      const invalidPlan = `goal: Invalid plan
details: Invalid details
unknownKey: invalid
tasks: []
`;
      await fs.writeFile(path.join(tempDir, 'invalid.yml'), invalidPlan);

      // Mock console methods to capture output
      const originalLog = console.log;
      const originalExit = process.exit;
      let exitCode: number | undefined;
      let logOutput: string[] = [];

      console.log = (...args) => {
        logOutput.push(args.join(' '));
      };

      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      }) as never;

      try {
        await handleValidateCommand({ dir: tempDir }, { parent: { opts: () => ({}) } });
      } catch (err) {
        // Expected since process.exit should be called
      } finally {
        console.log = originalLog;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1); // Should exit with error due to invalid file
      const output = logOutput.join('\\n');
      expect(output).toContain('✓ 1 valid');
      expect(output).toContain('✗ 1 invalid');
      expect(output).toContain('Unknown keys: unknownKey');
    });
  });
});
