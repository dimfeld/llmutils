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
          done: false,
        },
        {
          title: 'Implement Registration Endpoint',
          description: 'Create API endpoint for user registration with validation',
          done: false,
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

    // Check second task
    expect(result).toContain('## Task: Implement Registration Endpoint');
  });

  test('should handle plan with only title and goal', () => {
    const plan: PlanSchema = {
      title: 'Simple Plan',
      goal: 'A simple goal',
      status: 'pending',
      tasks: [],
    };

    const result = convertYamlToMarkdown(plan);

    expect(result).toContain('# Simple Plan');
    expect(result).toContain('## Goal\nA simple goal');
  });

  test('should include task IDs when requested', () => {
    const plan: PlanSchema = {
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'pending',
      tasks: [
        {
          title: 'First Task',
          description: 'First description',
          done: false,
        },
        {
          title: 'Second Task',
          description: 'Second description',
          done: false,
        },
      ],
    };

    const result = convertYamlToMarkdown(plan, { includeTaskIds: true });

    expect(result).toContain('[TASK-1]');
    expect(result).toContain('[TASK-2]');
  });

  test('should handle completed tasks', () => {
    const plan: PlanSchema = {
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'done',
      tasks: [
        {
          title: 'Completed Task',
          description: 'This task is done',
          done: true,
        },
      ],
    };

    const result = convertYamlToMarkdown(plan);

    expect(result).toContain('## Task: Completed Task ✓');
    expect(result).toContain('**Description:** This task is done');
  });

  test('should handle mixed completed and pending tasks', () => {
    const plan: PlanSchema = {
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'in_progress',
      tasks: [
        {
          title: 'Completed Task',
          description: 'This is done',
          done: true,
        },
        {
          title: 'Pending Task',
          description: 'This is not done',
          done: false,
        },
      ],
    };

    const result = convertYamlToMarkdown(plan);

    expect(result).toContain('## Task: Completed Task ✓');
    expect(result).toContain('## Task: Pending Task');
    expect(result).not.toContain('## Task: Pending Task ✓');
  });

  test('should handle plan with empty tasks array', () => {
    const plan: PlanSchema = {
      title: 'Empty Plan',
      goal: 'Test goal',
      status: 'pending',
      tasks: [],
    };

    const result = convertYamlToMarkdown(plan);

    expect(result).toContain('# Empty Plan');
    expect(result).toContain('## Goal\nTest goal');
    // Should not contain task sections
    expect(result).not.toContain('## Task:');
  });

  test('should properly format multi-line details', () => {
    const plan: PlanSchema = {
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Line 1\nLine 2\nLine 3',
      status: 'pending',
      tasks: [],
    };

    const result = convertYamlToMarkdown(plan);

    expect(result).toContain('### Details\nLine 1\nLine 2\nLine 3');
  });

  test('should handle task with multi-line description', () => {
    const plan: PlanSchema = {
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'pending',
      tasks: [
        {
          title: 'Multi-line Task',
          description: 'First line\nSecond line\nThird line',
          done: false,
        },
      ],
    };

    const result = convertYamlToMarkdown(plan);

    expect(result).toContain('**Description:** First line\nSecond line\nThird line');
  });
});
