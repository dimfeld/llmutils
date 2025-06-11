import { describe, expect, test } from 'bun:test';
import { convertYamlToMarkdown } from './process_markdown.js';
import type { PlanSchema } from './planSchema.js';

describe('convertYamlToMarkdown', () => {
  test('should convert a plan with all fields to markdown', () => {
    const plan: PlanSchema = {
      title: 'Implement User Authentication System',
      goal: 'Add secure user authentication to the application',
      details:
        'This plan covers implementing a complete authentication system including registration, login, password reset, and session management.',
      priority: 'high',
      status: 'pending',
      id: 123,
      planGeneratedAt: '2024-01-01T00:00:00.000Z',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      tasks: [
        {
          title: 'Create User Model and Database Schema',
          description: 'Define the user model with necessary fields and create database migrations',
          files: ['src/models/User.ts', 'src/db/migrations/001_create_users.ts'],
          steps: [
            {
              prompt:
                'Create a User model with fields for email, password hash, and created/updated timestamps.\nEnsure proper validation and indexing.',
              done: false,
            },
            {
              prompt: 'Create a database migration script to set up the users table',
              done: false,
            },
          ],
        },
        {
          title: 'Implement Registration Endpoint',
          description: 'Create API endpoint for user registration with validation',
          files: ['src/api/auth/register.ts', 'src/api/auth/validators.ts'],
          steps: [
            {
              prompt:
                'Create a registration endpoint that validates user input, hashes passwords, and creates new user records',
              done: false,
            },
          ],
        },
      ],
    };

    const result = convertYamlToMarkdown(plan);

    // Check that all sections are present and formatted correctly
    expect(result).toContain('# Implement User Authentication System');
    expect(result).toContain('## Goal\nAdd secure user authentication to the application');
    expect(result).toContain('## Priority\nhigh');
    expect(result).toContain(
      '### Details\nThis plan covers implementing a complete authentication system'
    );

    // Check task formatting
    expect(result).toContain('## Task: Create User Model and Database Schema');
    expect(result).toContain(
      '**Description:** Define the user model with necessary fields and create database migrations'
    );
    expect(result).toContain(
      '**Files:**\n- src/models/User.ts\n- src/db/migrations/001_create_users.ts'
    );

    // Check step formatting
    expect(result).toContain('**Steps:**');
    expect(result).toContain(
      '1.  **Prompt:**\n    ```\n    Create a User model with fields for email, password hash, and created/updated timestamps.\n    Ensure proper validation and indexing.\n    ```'
    );
    expect(result).toContain(
      '2.  **Prompt:**\n    ```\n    Create a database migration script to set up the users table\n    ```'
    );

    // Check second task
    expect(result).toContain('## Task: Implement Registration Endpoint');
  });

  test('should handle plan without optional fields', () => {
    const plan: PlanSchema = {
      goal: 'Basic goal without title or priority',
      details: 'Simple details',
      tasks: [
        {
          title: 'Simple Task',
          description: 'A basic task',
          steps: [],
        },
      ],
    };

    const result = convertYamlToMarkdown(plan);

    // Should not include title section if no title
    expect(result).not.toContain('# Title');

    // Should still have goal and details
    expect(result).toContain('## Goal\nBasic goal without title or priority');
    expect(result).toContain('### Details\nSimple details');

    // Should not include priority section if no priority
    expect(result).not.toContain('## Priority');

    // Should handle task with no files or steps
    expect(result).toContain('## Task: Simple Task');
    expect(result).toContain('**Description:** A basic task');
    expect(result).not.toContain('**Files:**');
    expect(result).not.toContain('**Steps:**');
  });

  test('should handle empty tasks array', () => {
    const plan: PlanSchema = {
      title: 'Plan with no tasks',
      goal: 'Test empty tasks',
      details: 'This plan has no tasks yet',
      priority: 'low',
      tasks: [],
    };

    const result = convertYamlToMarkdown(plan);

    expect(result).toContain('# Plan with no tasks');
    expect(result).toContain('## Goal\nTest empty tasks');
    expect(result).toContain('## Priority\nlow');
    expect(result).toContain('### Details\nThis plan has no tasks yet');
    expect(result).toContain('---');
    // Should not have any task sections
    expect(result).not.toContain('## Task:');
  });

  test('should properly escape backticks in step prompts', () => {
    const plan: PlanSchema = {
      goal: 'Test code block escaping',
      details: 'Test details',
      tasks: [
        {
          title: 'Code Task',
          description: 'Task with code in prompt',
          steps: [
            {
              prompt:
                'Create a function like this:\n```\nfunction test() {\n  return true;\n}\n```',
              done: false,
            },
          ],
        },
      ],
    };

    const result = convertYamlToMarkdown(plan);

    // Check that the backticks in the prompt are handled properly
    // The prompt should be wrapped in code blocks, with inner backticks escaped or handled
    expect(result).toContain('**Steps:**');
    expect(result).toContain('1.  **Prompt:**');
    // The content should be preserved but the backticks need proper handling
    expect(result).toContain('Create a function like this:');
    expect(result).toContain('function test() {');
  });

  test('should include task IDs when includeTaskIds option is true', () => {
    const plan: PlanSchema = {
      goal: 'Test task IDs',
      details: 'Test details',
      tasks: [
        {
          title: 'First Task',
          description: 'First task description',
          steps: [{ prompt: 'First step', done: false }],
        },
        {
          title: 'Second Task',
          description: 'Second task description',
          steps: [{ prompt: 'Second step', done: false }],
        },
      ],
    };

    const result = convertYamlToMarkdown(plan, { includeTaskIds: true });

    // Check that task IDs are included
    expect(result).toContain('## Task: First Task [TASK-1]');
    expect(result).toContain('## Task: Second Task [TASK-2]');
  });

  test('should separate completed and pending tasks', () => {
    const plan: PlanSchema = {
      goal: 'Test completed vs pending tasks',
      details: 'Test details',
      tasks: [
        {
          title: 'Completed Task',
          description: 'This task is done',
          steps: [
            { prompt: 'Step 1', done: true },
            { prompt: 'Step 2', done: true },
          ],
        },
        {
          title: 'Pending Task',
          description: 'This task is not done',
          steps: [
            { prompt: 'Step 1', done: false },
            { prompt: 'Step 2', done: false },
          ],
        },
        {
          title: 'Partially Done Task',
          description: 'This task is partially done',
          steps: [
            { prompt: 'Step 1', done: true },
            { prompt: 'Step 2', done: false },
          ],
        },
      ],
    };

    const result = convertYamlToMarkdown(plan, { includeTaskIds: true });

    // Check that completed tasks section exists
    expect(result).toContain('# Completed Tasks');
    expect(result).toContain('*These tasks have been completed and should not be modified.*');
    expect(result).toContain('## Task: Completed Task [TASK-1] ✓');
    expect(result).toContain('**Steps:** *(All completed)*');

    // Check that pending tasks section exists
    expect(result).toContain('# Pending Tasks');
    expect(result).toContain('*These tasks can be updated, modified, or removed as needed.*');
    expect(result).toContain('## Task: Pending Task [TASK-2]');
    expect(result).toContain('## Task: Partially Done Task [TASK-3]');

    // Verify completed task steps have checkmarks
    const completedTaskIndex = result.indexOf('## Task: Completed Task');
    const pendingTaskIndex = result.indexOf('## Task: Pending Task');
    const completedSection = result.substring(completedTaskIndex, pendingTaskIndex);
    expect(completedSection).toContain('1.  **Prompt:** ✓');
    expect(completedSection).toContain('2.  **Prompt:** ✓');

    // Verify partially done task shows which steps are done
    const partiallyDoneIndex = result.indexOf('## Task: Partially Done Task');
    const partiallyDoneSection = result.substring(partiallyDoneIndex);
    expect(partiallyDoneSection).toContain('1.  **Prompt:** ✓');
    expect(partiallyDoneSection).toContain('2.  **Prompt:**\n'); // No checkmark for undone step
  });

  test('should handle plan with only completed tasks', () => {
    const plan: PlanSchema = {
      goal: 'Test all completed tasks',
      details: 'Test details',
      tasks: [
        {
          title: 'Completed Task 1',
          description: 'First completed task',
          steps: [{ prompt: 'Done step', done: true }],
        },
        {
          title: 'Completed Task 2',
          description: 'Second completed task',
          steps: [{ prompt: 'Another done step', done: true }],
        },
      ],
    };

    const result = convertYamlToMarkdown(plan);

    // Should have completed tasks section
    expect(result).toContain('# Completed Tasks');
    expect(result).toContain('*These tasks have been completed and should not be modified.*');

    // Should NOT have pending tasks section
    expect(result).not.toContain('# Pending Tasks');

    // Both tasks should be marked as completed
    expect(result).toContain('## Task: Completed Task 1 ✓');
    expect(result).toContain('## Task: Completed Task 2 ✓');
  });

  test('should handle plan with only pending tasks', () => {
    const plan: PlanSchema = {
      goal: 'Test all pending tasks',
      details: 'Test details',
      tasks: [
        {
          title: 'Pending Task 1',
          description: 'First pending task',
          steps: [{ prompt: 'Not done step', done: false }],
        },
        {
          title: 'Pending Task 2',
          description: 'Second pending task',
          steps: [{ prompt: 'Another not done step', done: false }],
        },
      ],
    };

    const result = convertYamlToMarkdown(plan);

    // Should NOT have completed tasks section
    expect(result).not.toContain('# Completed Tasks');

    // Should NOT have pending tasks header when there are no completed tasks
    expect(result).not.toContain('# Pending Tasks');

    // Tasks should not have checkmarks
    expect(result).toContain('## Task: Pending Task 1');
    expect(result).toContain('## Task: Pending Task 2');
    expect(result).not.toContain('✓');
  });

  test('should handle tasks with no steps correctly', () => {
    const plan: PlanSchema = {
      goal: 'Test tasks without steps',
      details: 'Test details',
      tasks: [
        {
          title: 'Task Without Steps',
          description: 'This task has no steps',
          steps: [],
        },
        {
          title: 'Task With Steps',
          description: 'This task has steps',
          steps: [{ prompt: 'A step', done: true }],
        },
      ],
    };

    const result = convertYamlToMarkdown(plan);

    // Should have both completed and pending sections
    expect(result).toContain('# Completed Tasks');
    expect(result).toContain('# Pending Tasks');

    // Task without steps should be in pending section
    expect(result).toContain('## Task: Task Without Steps');
    expect(result.indexOf('## Task: Task Without Steps')).toBeGreaterThan(
      result.indexOf('# Pending Tasks')
    );

    // Task with all steps done should be in completed section
    expect(result).toContain('## Task: Task With Steps ✓');
    expect(result.indexOf('## Task: Task With Steps')).toBeGreaterThan(
      result.indexOf('# Completed Tasks')
    );
    expect(result.indexOf('## Task: Task With Steps')).toBeLessThan(
      result.indexOf('# Pending Tasks')
    );
  });
});
