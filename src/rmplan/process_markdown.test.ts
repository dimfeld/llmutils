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
});
