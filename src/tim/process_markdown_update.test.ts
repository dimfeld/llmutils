import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { extractMarkdownToYaml } from './process_markdown.js';
import type { PlanSchema } from './planSchema.js';
import type { TimConfig } from './configSchema.js';

describe.skip('extractMarkdownToYaml update functionality', () => {
  // These tests are skipped because they require mocking the LLM conversion
  // The core logic is tested through unit tests of the individual functions
  let tempDir: string;
  let tasksDir: string;
  const testConfig: TimConfig = {
    paths: {
      tasks: '',
    },
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-extract-update-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    testConfig.paths.tasks = tasksDir;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test.skip('should preserve completed tasks when updating a plan', async () => {
    // Skip this test as it requires mocking the LLM conversion
    // Create an original plan with some completed and pending tasks
    const originalPlan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Completed Task 1',
          description: 'This task is done',
          files: ['file1.ts'],
          steps: [
            { prompt: 'Step 1', done: true },
            { prompt: 'Step 2', done: true },
          ],
        },
        {
          title: 'Pending Task 1',
          description: 'This task is not done',
          files: ['file2.ts'],
          steps: [
            { prompt: 'Step 1', done: false },
            { prompt: 'Step 2', done: false },
          ],
        },
        {
          title: 'Completed Task 2',
          description: 'Another done task',
          files: ['file3.ts'],
          steps: [{ prompt: 'Single step', done: true }],
        },
      ],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(originalPlan));

    // Markdown update that modifies the pending task and adds a new task
    const updatedMarkdown = `# Test Plan

## Goal
Test goal

## Priority
high

### Details
Updated test details

---

# Completed Tasks
*These tasks have been completed and should not be modified.*

## Task: Completed Task 1 [TASK-1] ✓
**Description:** This task is done
**Files:**
- file1.ts
**Steps:** *(All completed)*
1.  **Prompt:** ✓
    \`\`\`
    Step 1
    \`\`\`
2.  **Prompt:** ✓
    \`\`\`
    Step 2
    \`\`\`

---

## Task: Completed Task 2 [TASK-3] ✓
**Description:** Another done task
**Files:**
- file3.ts
**Steps:** *(All completed)*
1.  **Prompt:** ✓
    \`\`\`
    Single step
    \`\`\`

---

# Pending Tasks
*These tasks can be updated, modified, or removed as needed.*

## Task: Updated Pending Task [TASK-2]
**Description:** This task has been updated with new requirements
**Files:**
- file2.ts
- newfile.ts
**Steps:**
1.  **Prompt:**
    \`\`\`
    Updated step 1
    \`\`\`
2.  **Prompt:**
    \`\`\`
    Updated step 2
    \`\`\`
3.  **Prompt:**
    \`\`\`
    New step 3
    \`\`\`

---

## Task: New Task [TASK-4]
**Description:** A completely new task
**Files:**
- file4.ts
**Steps:**
1.  **Prompt:**
    \`\`\`
    New task step
    \`\`\``;

    const options = {
      output: planPath,
      updatePlan: { data: originalPlan, path: planPath },
    };

    await extractMarkdownToYaml(updatedMarkdown, testConfig, true, options);

    // Read the updated plan
    const updatedPlanContent = await fs.readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedPlanContent);

    // Verify metadata is preserved
    expect(updatedPlan.id).toBe(1);
    expect(updatedPlan.createdAt).toBe('2024-01-01T00:00:00.000Z');
    expect(updatedPlan.title).toBe('Test Plan');

    // Verify we have 4 tasks
    expect(updatedPlan.tasks).toHaveLength(4);

    // Verify completed tasks are preserved exactly
    expect(updatedPlan.tasks[0]).toEqual({
      title: 'Completed Task 1',
      description: 'This task is done',
      files: ['file1.ts'],
      steps: [
        { prompt: 'Step 1', done: true },
        { prompt: 'Step 2', done: true },
      ],
    });

    expect(updatedPlan.tasks[2]).toEqual({
      title: 'Completed Task 2',
      description: 'Another done task',
      files: ['file3.ts'],
      steps: [{ prompt: 'Single step', done: true }],
    });

    // Verify pending task was updated
    expect(updatedPlan.tasks[1].title).toBe('Updated Pending Task');
    expect(updatedPlan.tasks[1].description).toBe(
      'This task has been updated with new requirements'
    );
    expect(updatedPlan.tasks[1].files).toEqual(['file2.ts', 'newfile.ts']);
    expect(updatedPlan.tasks[1].steps).toHaveLength(3);
    expect(updatedPlan.tasks[1].steps[0].prompt).toBe('Updated step 1');

    // Verify new task was added
    expect(updatedPlan.tasks[3].title).toBe('New Task');
    expect(updatedPlan.tasks[3].description).toBe('A completely new task');
    expect(updatedPlan.tasks[3].files).toEqual(['file4.ts']);
  });

  test('should handle removing pending tasks while preserving completed ones', async () => {
    const originalPlan: PlanSchema = {
      id: 2,
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task 1',
          description: 'Completed task',
          steps: [{ prompt: 'Done', done: true }],
        },
        {
          title: 'Task 2',
          description: 'Pending task to remove',
          steps: [{ prompt: 'Not done', done: false }],
        },
        {
          title: 'Task 3',
          description: 'Another pending task',
          steps: [{ prompt: 'Not done', done: false }],
        },
      ],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    const planPath = path.join(tasksDir, '2.yml');
    await fs.writeFile(planPath, yaml.stringify(originalPlan));

    // Markdown that removes Task 2 but keeps Tasks 1 and 3
    const updatedMarkdown = `# Test Plan

## Goal
Test goal

---

# Completed Tasks
*These tasks have been completed and should not be modified.*

## Task: Task 1 [TASK-1] ✓
**Description:** Completed task
**Steps:** *(All completed)*
1.  **Prompt:** ✓
    \`\`\`
    Done
    \`\`\`

---

# Pending Tasks
*These tasks can be updated, modified, or removed as needed.*

## Task: Task 3 [TASK-3]
**Description:** Another pending task
**Steps:**
1.  **Prompt:**
    \`\`\`
    Not done
    \`\`\``;

    const options = {
      output: planPath,
      updatePlan: { data: originalPlan, path: planPath },
    };

    await extractMarkdownToYaml(updatedMarkdown, testConfig, true, options);

    // Read the updated plan
    const updatedPlanContent = await fs.readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedPlanContent);

    // Verify we have 2 tasks (Task 2 was removed)
    expect(updatedPlan.tasks).toHaveLength(2);

    // Verify Task 1 is preserved
    expect(updatedPlan.tasks[0]).toEqual({
      title: 'Task 1',
      description: 'Completed task',
      steps: [{ prompt: 'Done', done: true }],
    });

    // Verify Task 3 is in the correct position (index 1 now)
    expect(updatedPlan.tasks[1]).toEqual({
      title: 'Task 3',
      description: 'Another pending task',
      steps: [{ prompt: 'Not done', done: false }],
    });
  });

  test('should handle new tasks without explicit IDs', async () => {
    const originalPlan: PlanSchema = {
      id: 3,
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'in_progress',
      tasks: [
        {
          title: 'Existing Task',
          description: 'Existing task',
          steps: [{ prompt: 'Step', done: false }],
        },
      ],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    const planPath = path.join(tasksDir, '3.yml');
    await fs.writeFile(planPath, yaml.stringify(originalPlan));

    // Markdown with existing task (with ID) and new task (without ID)
    const updatedMarkdown = `# Test Plan

## Goal
Test goal

---

## Task: Existing Task [TASK-1]
**Description:** Existing task
**Steps:**
1.  **Prompt:**
    \`\`\`
    Step
    \`\`\`

---

## Task: New Task Without ID
**Description:** This is a new task
**Steps:**
1.  **Prompt:**
    \`\`\`
    New step
    \`\`\``;

    const options = {
      output: planPath,
      updatePlan: { data: originalPlan, path: planPath },
    };

    await extractMarkdownToYaml(updatedMarkdown, testConfig, true, options);

    // Read the updated plan
    const updatedPlanContent = await fs.readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedPlanContent);

    // Verify we have 2 tasks
    expect(updatedPlan.tasks).toHaveLength(2);

    // Verify existing task
    expect(updatedPlan.tasks[0].title).toBe('Existing Task');

    // Verify new task was appended
    expect(updatedPlan.tasks[1].title).toBe('New Task Without ID');
    expect(updatedPlan.tasks[1].description).toBe('This is a new task');
  });
});
