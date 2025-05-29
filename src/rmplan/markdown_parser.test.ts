import { describe, expect, it } from 'bun:test';
import { parseMarkdownPlan } from './markdown_parser';

describe('parseMarkdownPlan', () => {
  it('should parse a multi-phase markdown plan', async () => {
    const markdown = `# Goal

Implement a comprehensive user authentication system.

## Details

This project involves creating a secure, scalable authentication system with OAuth support.

### Phase 1: Basic Authentication

#### Goal
Implement basic username/password authentication with secure password hashing.

#### Dependencies
None

#### Details
Set up the foundation for user authentication including database models and basic endpoints.

##### Task: Create User Model
**Description:** Define the user schema with fields for email, hashed password, and profile information.

##### Task: Implement Registration Endpoint
**Description:** Create API endpoint for user registration with validation and password hashing.

### Phase 2: OAuth Integration

#### Goal
Add OAuth 2.0 support for Google and GitHub authentication.

#### Dependencies
Phase 1

#### Details
Extend the authentication system to support third-party OAuth providers.

##### Task: OAuth Provider Setup
**Description:** Configure OAuth applications with Google and GitHub, store client credentials securely.
`;

    const result = await parseMarkdownPlan(markdown);

    expect(result.overallGoal).toBe('Implement a comprehensive user authentication system.');
    expect(result.overallDetails).toBe(
      'This project involves creating a secure, scalable authentication system with OAuth support.'
    );
    expect(result.phases).toHaveLength(2);

    // Check Phase 1
    const phase1 = result.phases[0];
    expect(phase1.title).toBe('Basic Authentication');
    expect(phase1.numericIndex).toBe(1);
    expect(phase1.goal).toBe(
      'Implement basic username/password authentication with secure password hashing.'
    );
    expect(phase1.dependencies).toEqual([]);
    expect(phase1.details).toBe(
      'Set up the foundation for user authentication including database models and basic endpoints.'
    );
    expect(phase1.tasks).toHaveLength(2);
    expect(phase1.tasks[0].title).toBe('Create User Model');
    expect(phase1.tasks[0].description).toBe(
      'Define the user schema with fields for email, hashed password, and profile information.'
    );

    // Check Phase 2
    const phase2 = result.phases[1];
    expect(phase2.title).toBe('OAuth Integration');
    expect(phase2.numericIndex).toBe(2);
    expect(phase2.dependencies).toEqual(['Phase 1']);
    expect(phase2.tasks).toHaveLength(1);
    expect(phase2.tasks[0].title).toBe('OAuth Provider Setup');
  });

  it('should handle single-phase fallback when no phase headers are present', async () => {
    const markdown = `# Goal

Create a simple todo list application.

## Details

A basic todo list with CRUD operations.

##### Task: Setup Database
**Description:** Create SQLite database with tasks table.

##### Task: Build API
**Description:** Create REST endpoints for todo operations.
`;

    const result = await parseMarkdownPlan(markdown);

    expect(result.overallGoal).toBe('Create a simple todo list application.');
    expect(result.overallDetails).toBe('A basic todo list with CRUD operations.');
    expect(result.phases).toHaveLength(1);

    const phase = result.phases[0];
    expect(phase.title).toBe('Implementation');
    expect(phase.numericIndex).toBe(1);
    expect(phase.goal).toBe('Create a simple todo list application.');
    expect(phase.dependencies).toEqual([]);
    expect(phase.tasks).toHaveLength(2);
    expect(phase.tasks[0].title).toBe('Setup Database');
    expect(phase.tasks[1].title).toBe('Build API');
  });

  it('should create default task when no tasks are specified', async () => {
    const markdown = `# Goal

Implement caching layer.

## Details

Add Redis caching to improve performance.
`;

    const result = await parseMarkdownPlan(markdown);

    expect(result.phases).toHaveLength(1);
    const phase = result.phases[0];
    expect(phase.tasks).toHaveLength(1);
    expect(phase.tasks[0].title).toBe('Implement caching layer.');
    expect(phase.tasks[0].description).toBe('Add Redis caching to improve performance.');
  });

  it('should parse multiple dependencies correctly', async () => {
    const markdown = `### Phase 3: Advanced Features

#### Goal
Add advanced features.

#### Dependencies
Phase 1, Phase 2

#### Details
Build on previous phases.
`;

    const result = await parseMarkdownPlan(markdown);

    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].dependencies).toEqual(['Phase 1', 'Phase 2']);
  });

  it('should handle "None" dependencies', async () => {
    const markdown = `### Phase 1: Setup

#### Goal
Initial setup.

#### Dependencies
None

#### Details
Basic setup tasks.
`;

    const result = await parseMarkdownPlan(markdown);

    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].dependencies).toEqual([]);
  });
});
