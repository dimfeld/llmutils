import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleValidateCommand } from './validate.js';
import type { RmplanConfig } from '../configSchema.js';
import { readPlanFile } from '../plans.js';

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
    done: false
  - title: Implement auth service
    description: Create authentication service
    done: false
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
    done: false
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

    test('should detect removed fields (steps, files) as invalid', async () => {
      const invalidPlan = `goal: Test plan
details: Test details
tasks:
  - title: Task 1
    description: First task
    files: []
    steps:
      - prompt: Step 1
        done: false
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
      expect(logOutput.join('\\n')).toContain('Unknown keys: tasks.0.files, tasks.0.steps');
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
      expect(output).toContain('tasks.0.files');
      expect(output).toContain('tasks.0.steps');
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

  describe('parent-child validation', () => {
    test('should pass validation when child has parent and parent includes child in dependencies', async () => {
      // Create parent plan that includes child in dependencies
      const parentPlan = `---
id: 1
goal: Parent plan
details: This is the parent
dependencies: [2]
tasks:
  - title: Parent task
    description: Parent task description
    done: false


---

Additional parent plan details.`;

      // Create child plan with parent field
      const childPlan = `---
id: 2
goal: Child plan
details: This is the child
parent: 1
tasks:
  - title: Child task
    description: Child task description
    done: false


---

Additional child plan details.`;

      await fs.writeFile(path.join(tempDir, 'parent.plan.md'), parentPlan);
      await fs.writeFile(path.join(tempDir, 'child.plan.md'), childPlan);

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
      const output = logOutput.join('\\n');
      expect(output).toContain('✓ 2 valid');
      expect(output).not.toContain('parent-child inconsistencies');
    });

    test('should detect and auto-fix missing parent dependency', async () => {
      // Create parent plan that does NOT include child in dependencies
      const parentPlan = `---
id: 1
goal: Parent plan
details: This is the parent
tasks:
  - title: Parent task
    description: Parent task description
    done: false


---

Additional parent plan details.`;

      // Create child plan with parent field
      const childPlan = `---
id: 2
goal: Child plan
details: This is the child
parent: 1
tasks:
  - title: Child task
    description: Child task description
    done: false


---

Additional child plan details.`;

      await fs.writeFile(path.join(tempDir, 'parent.plan.md'), parentPlan);
      await fs.writeFile(path.join(tempDir, 'child.plan.md'), childPlan);

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
      const output = logOutput.join('\\n');
      expect(output).toContain('✓ 2 valid');
      expect(output).toContain('Found 1 parent-child inconsistencies');
      expect(output).toContain('Parent plan 1 missing dependencies for child 2');
      expect(output).toContain('1 parent-child relationships fixed');
      expect(output).toContain('Updated plan 1 to include child 2 in dependencies');

      // Verify the parent file was actually updated
      const updatedParentContent = await fs.readFile(path.join(tempDir, 'parent.plan.md'), 'utf-8');
      expect(updatedParentContent).toContain('dependencies:');
      expect(updatedParentContent).toContain('- 2');
      // Validation fixes should not update the timestamp
      expect(updatedParentContent).not.toContain('updatedAt:');
    });

    test('should handle multiple children with same parent', async () => {
      // Create parent plan without any dependencies
      const parentPlan = `---
id: 1
goal: Parent plan
details: This is the parent
tasks:
  - title: Parent task
    description: Parent task description
    done: false


---

Additional parent plan details.`;

      // Create two child plans with same parent
      const child1Plan = `---
id: 2
goal: Child plan 1
details: This is child 1
parent: 1
tasks:
  - title: Child task 1
    description: Child task 1 description
    done: false


---

Additional child 1 plan details.`;

      const child2Plan = `---
id: 3
goal: Child plan 2
details: This is child 2
parent: 1
tasks:
  - title: Child task 2
    description: Child task 2 description
    done: false


---

Additional child 2 plan details.`;

      await fs.writeFile(path.join(tempDir, 'parent.plan.md'), parentPlan);
      await fs.writeFile(path.join(tempDir, 'child1.plan.md'), child1Plan);
      await fs.writeFile(path.join(tempDir, 'child2.plan.md'), child2Plan);

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
      const output = logOutput.join('\\n');
      expect(output).toContain('✓ 3 valid');
      expect(output).toContain('Found 1 parent-child inconsistencies');
      expect(output).toContain('Parent plan 1 missing dependencies for children');
      expect(output).toContain('1 parent-child relationships fixed');

      // Verify the parent file was updated with both children
      const updatedParentContent = await fs.readFile(path.join(tempDir, 'parent.plan.md'), 'utf-8');
      expect(updatedParentContent).toContain('dependencies:');
      expect(updatedParentContent).toContain('- 2');
      expect(updatedParentContent).toContain('- 3');
    });

    test('should not fix when --no-fix flag is used', async () => {
      // Create parent plan without dependencies
      const parentPlan = `---
id: 1
goal: Parent plan
details: This is the parent
tasks:
  - title: Parent task
    description: Parent task description
    done: false


---

Additional parent plan details.`;

      // Create child plan with parent field
      const childPlan = `---
id: 2
goal: Child plan
details: This is the child
parent: 1
tasks:
  - title: Child task
    description: Child task description
    done: false


---

Additional child plan details.`;

      await fs.writeFile(path.join(tempDir, 'parent.plan.md'), parentPlan);
      await fs.writeFile(path.join(tempDir, 'child.plan.md'), childPlan);

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
        await handleValidateCommand({ dir: tempDir, fix: false }, { parent: { opts: () => ({}) } });
      } catch (err) {
        // Expected if process.exit is called
      } finally {
        console.log = originalLog;
        process.exit = originalExit;
      }

      expect(exitCode).toBeUndefined(); // Should not exit with error
      const output = logOutput.join('\\n');
      expect(output).toContain('✓ 2 valid');
      expect(output).toContain('Found 1 parent-child inconsistencies');
      expect(output).toContain('--no-fix flag specified');
      expect(output).toContain('Run without --no-fix to automatically fix');
      expect(output).toContain('1 parent-child inconsistencies found (not fixed due to --no-fix)');
      expect(output).not.toContain('parent-child relationships fixed');

      // Verify the parent file was NOT updated
      const parentContent = await fs.readFile(path.join(tempDir, 'parent.plan.md'), 'utf-8');
      expect(parentContent).not.toContain('dependencies:');
    });

    test('should handle non-existent parent ID gracefully', async () => {
      // Create child plan with non-existent parent
      const childPlan = `---
id: 2
goal: Child plan
details: This is the child
parent: 999
tasks:
  - title: Child task
    description: Child task description
    done: false


---

Additional child plan details.`;

      await fs.writeFile(path.join(tempDir, 'child.plan.md'), childPlan);

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
      const output = logOutput.join('\\n');
      expect(output).toContain('✓ 1 valid');
      expect(output).not.toContain('parent-child inconsistencies');
    });

    test('should handle circular dependency detection', async () => {
      // Create a potential circular dependency scenario
      // Parent plan depends on child, child has parent field
      const parentPlan = `---
id: 1
goal: Parent plan
details: This is the parent
dependencies: [2]
tasks:
  - title: Parent task
    description: Parent task description
    done: false


---

Additional parent plan details.`;

      // Create child that depends on another plan that depends on parent
      const childPlan = `---
id: 2
goal: Child plan
details: This is the child
parent: 1
dependencies: [3]
tasks:
  - title: Child task
    description: Child task description
    done: false


---

Additional child plan details.`;

      const grandchildPlan = `---
id: 3
goal: Grandchild plan
details: This is the grandchild
dependencies: [1]
tasks:
  - title: Grandchild task
    description: Grandchild task description
    done: false


---

Additional grandchild plan details.`;

      await fs.writeFile(path.join(tempDir, 'parent.plan.md'), parentPlan);
      await fs.writeFile(path.join(tempDir, 'child.plan.md'), childPlan);
      await fs.writeFile(path.join(tempDir, 'grandchild.plan.md'), grandchildPlan);

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
      const output = logOutput.join('\\n');
      expect(output).toContain('✓ 3 valid');
      // Since parent already includes child 2, there should be no inconsistencies
      expect(output).not.toContain('parent-child inconsistencies');
    });
  });

  describe('obsolete task keys', () => {
    test('should detect and remove obsolete task keys (files, docs, steps, examples)', async () => {
      const planWithObsoleteKeys = `---
id: 100
goal: Test plan with obsolete keys
details: Plan with tasks containing obsolete fields
tasks:
  - title: Task with obsolete keys
    description: First task
    done: false
    files: []
    steps:
      - prompt: Step 1
        done: false
    docs: some docs
    examples: some examples
  - title: Clean task
    description: Second task
    done: false
---

Plan body.`;

      await fs.writeFile(path.join(tempDir, 'obsolete.plan.md'), planWithObsoleteKeys);

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

      expect(exitCode).toBeUndefined();
      const output = logOutput.join('\\n');
      expect(output).toContain('Found 1 plan with 1 task containing obsolete keys');
      expect(output).toContain('Auto-fixing obsolete task keys before validation');
      expect(output).toContain('✓ Fixed 1 plan, removed 4 obsolete key');

      // Verify the plan was actually updated
      const updatedPlan = await readPlanFile(path.join(tempDir, 'obsolete.plan.md'));
      expect(updatedPlan.tasks[0]).not.toHaveProperty('files');
      expect(updatedPlan.tasks[0]).not.toHaveProperty('steps');
      expect(updatedPlan.tasks[0]).not.toHaveProperty('docs');
      expect(updatedPlan.tasks[0]).not.toHaveProperty('examples');
      expect(updatedPlan.tasks[0]).toHaveProperty('title');
      expect(updatedPlan.tasks[0]).toHaveProperty('description');
      expect(updatedPlan.tasks[0]).toHaveProperty('done');
    });

    test('should handle multiple tasks with obsolete keys', async () => {
      const planWithMultipleObsoleteTasks = `---
id: 101
goal: Plan with multiple obsolete tasks
details: Multiple tasks with obsolete fields
tasks:
  - title: Task 1
    description: First task
    files: []
  - title: Task 2
    description: Second task
    steps:
      - prompt: Step
        done: false
  - title: Task 3
    description: Third task
    docs: docs
    examples: examples
---

Plan body.`;

      await fs.writeFile(path.join(tempDir, 'multiple-obsolete.plan.md'), planWithMultipleObsoleteTasks);

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

      expect(exitCode).toBeUndefined();
      const output = logOutput.join('\\n');
      expect(output).toContain('Found 1 plan with 3 tasks containing obsolete keys');
      expect(output).toContain('✓ Fixed 1 plan, removed 4 obsolete key');

      // Verify all tasks were cleaned
      const updatedPlan = await readPlanFile(path.join(tempDir, 'multiple-obsolete.plan.md'));
      expect(updatedPlan.tasks[0]).not.toHaveProperty('files');
      expect(updatedPlan.tasks[1]).not.toHaveProperty('steps');
      expect(updatedPlan.tasks[2]).not.toHaveProperty('docs');
      expect(updatedPlan.tasks[2]).not.toHaveProperty('examples');
    });

    test('should not fix when --no-fix flag is used', async () => {
      const planWithObsoleteKeys = `---
id: 102
goal: Plan with obsolete keys
details: Testing no-fix flag
tasks:
  - title: Task 1
    description: First task
    files: []
    steps:
      - prompt: Step
        done: false
---

Plan body.`;

      await fs.writeFile(path.join(tempDir, 'no-fix-obsolete.plan.md'), planWithObsoleteKeys);

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
        await handleValidateCommand({ dir: tempDir, fix: false }, { parent: { opts: () => ({}) } });
      } catch (err) {
        // Expected if process.exit is called (due to schema validation errors)
      } finally {
        console.log = originalLog;
        process.exit = originalExit;
      }

      // When --no-fix is used, obsolete keys cause schema validation to fail, so exit code should be 1
      expect(exitCode).toBe(1);
      const output = logOutput.join('\\n');
      expect(output).toContain('Found 1 plan with 1 task containing obsolete keys');
      expect(output).toContain('--no-fix flag specified, will report as validation errors');
      expect(output).toContain('✗ 1 invalid');
      expect(output).toContain('Unknown keys: tasks.0.files, tasks.0.steps');
      expect(output).toContain('1 plan with 1 task containing obsolete keys (not fixed due to --no-fix)');

      // Verify the plan was NOT updated
      const plan = await readPlanFile(path.join(tempDir, 'no-fix-obsolete.plan.md'));
      expect(plan.tasks[0]).toHaveProperty('files');
      expect(plan.tasks[0]).toHaveProperty('steps');
    });

    test('should show nothing when no obsolete keys found', async () => {
      const cleanPlan = `---
id: 103
goal: Clean plan
details: No obsolete keys
tasks:
  - title: Task 1
    description: First task
    done: false
---

Plan body.`;

      await fs.writeFile(path.join(tempDir, 'clean.plan.md'), cleanPlan);

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
        await handleValidateCommand({ dir: tempDir, verbose: true }, { parent: { opts: () => ({}) } });
      } catch (err) {
        // Expected if process.exit is called
      } finally {
        console.log = originalLog;
        process.exit = originalExit;
      }

      expect(exitCode).toBeUndefined();
      const output = logOutput.join('\\n');
      // When no obsolete keys are found, no message is shown about obsolete keys
      expect(output).not.toContain('obsolete');
      expect(output).toContain('✓ 1 valid');
    });
  });

  describe('discoveredFrom validation', () => {
    test('should pass validation when discoveredFrom references an existing plan', async () => {
      const sourcePlan = `---
id: 50
goal: Source plan
details: Source details
tasks:
  - title: Source task
    description: Source task description
    done: false


---

Source plan body.`;

      const discoveredPlan = `---
id: 51
goal: Discovered plan
details: Discovered plan details
discoveredFrom: 50
tasks:
  - title: Discovered task
    description: Discovered task description
    done: false


---

Discovered plan body.`;

      await fs.writeFile(path.join(tempDir, 'source.plan.md'), sourcePlan);
      await fs.writeFile(path.join(tempDir, 'discovered.plan.md'), discoveredPlan);

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

      expect(exitCode).toBeUndefined();
      const output = logOutput.join('\\n');
      expect(output).toContain('Checking discoveredFrom references...');
      expect(output).not.toContain('orphaned discovery references');
      expect(output).not.toContain('discoveredFrom reference removed');
    });

    test('should detect and remove invalid discoveredFrom references', async () => {
      const orphanPlan = `---
id: 60
goal: Orphan plan
details: Plan referencing missing discovery source
discoveredFrom: 999
tasks:
  - title: Orphan task
    description: Task details


---

Orphan plan body.`;

      await fs.writeFile(path.join(tempDir, 'orphan.plan.md'), orphanPlan);

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

      expect(exitCode).toBeUndefined();
      const output = logOutput.join('\\n');
      expect(output).toContain('Found 1 orphaned discovery reference');
      expect(output).toContain('Removing invalid discoveredFrom references...');
      expect(output).toContain('DiscoveredFrom References Fixed:');
      expect(output).toContain('Removed discoveredFrom reference to 999 from plan 60');
      expect(output).toContain('1 discoveredFrom reference removed');

      const plan = await readPlanFile(path.join(tempDir, 'orphan.plan.md'));
      expect(plan.discoveredFrom).toBeUndefined();
    });

    test('should warn without fixing when --no-fix flag is provided', async () => {
      const orphanPlan = `---
id: 70
goal: Another orphan plan
details: Plan referencing missing discovery source
discoveredFrom: 888
tasks:
  - title: Orphan task
    description: Task details


---

Orphan plan body.`;

      await fs.writeFile(path.join(tempDir, 'no-fix.plan.md'), orphanPlan);

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
        await handleValidateCommand({ dir: tempDir, fix: false }, { parent: { opts: () => ({}) } });
      } catch (err) {
        // Expected if process.exit is called
      } finally {
        console.log = originalLog;
        process.exit = originalExit;
      }

      expect(exitCode).toBeUndefined();
      const output = logOutput.join('\\n');
      expect(output).toContain('Found 1 orphaned discovery reference');
      expect(output).toContain('--no-fix flag specified, not removing discoveredFrom references.');
      expect(output).toContain(
        'orphaned discoveredFrom reference found (not fixed due to --no-fix)'
      );
      expect(output).not.toContain('DiscoveredFrom References Fixed:');
      expect(output).not.toContain('discoveredFrom reference removed');

      const plan = await readPlanFile(path.join(tempDir, 'no-fix.plan.md'));
      expect(plan.discoveredFrom).toBe(888);
    });
  });
});
