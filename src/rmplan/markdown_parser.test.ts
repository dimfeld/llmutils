import { describe, expect, test } from 'bun:test';
import { parseMarkdownPlan } from './markdown_parser';

describe('parseMarkdownPlan', () => {
  describe('Multi-phase plan', () => {
    test('should correctly parse multi-phase plan with all fields', async () => {
      const markdown = `# Goal

Implement a comprehensive authentication system with multiple phases.

## Details

This is a multi-phase project that will build a complete authentication system starting with basic functionality and adding advanced features incrementally.

### Phase 1: Basic Authentication

#### Goal

Implement core authentication functionality including user registration and login.

#### Dependencies

None

#### Details

This phase establishes the foundation with basic user management and authentication endpoints.

##### Task: Create User Model

**Description:** Design and implement the user model with email, password hash, and basic profile fields.

##### Task: Implement Registration Endpoint

**Description:** Create the /auth/register endpoint with validation and password hashing.

##### Task: Implement Login Endpoint

**Description:** Create the /auth/login endpoint that returns JWT tokens.

### Phase 2: Advanced Security Features

#### Goal

Add two-factor authentication and password reset functionality.

#### Dependencies

Phase 1

#### Details

This phase enhances security with 2FA and account recovery options.

##### Task: Add 2FA Support

**Description:** Implement TOTP-based two-factor authentication.

##### Task: Password Reset Flow

**Description:** Create email-based password reset functionality.

### Phase 3: OAuth Integration

#### Goal

Integrate OAuth providers for social login.

#### Dependencies

Phase 1, Phase 2

#### Details

Allow users to authenticate using Google, GitHub, and other OAuth providers.

##### Task: OAuth Provider Framework

**Description:** Create a flexible framework for adding OAuth providers.
`;

      const result = await parseMarkdownPlan(markdown);

      expect(result.overallGoal).toBe(
        'Implement a comprehensive authentication system with multiple phases.'
      );
      expect(result.overallDetails).toBe(
        'This is a multi-phase project that will build a complete authentication system starting with basic functionality and adding advanced features incrementally.'
      );
      expect(result.phases).toHaveLength(3);

      // Phase 1
      expect(result.phases[0].numericIndex).toBe(1);
      expect(result.phases[0].title).toBe('Basic Authentication');
      expect(result.phases[0].goal).toBe(
        'Implement core authentication functionality including user registration and login.'
      );
      expect(result.phases[0].dependencies).toEqual([]);
      expect(result.phases[0].details).toBe(
        'This phase establishes the foundation with basic user management and authentication endpoints.'
      );
      expect(result.phases[0].tasks).toHaveLength(3);
      expect(result.phases[0].tasks[0].title).toBe('Create User Model');
      expect(result.phases[0].tasks[0].description).toBe(
        'Design and implement the user model with email, password hash, and basic profile fields.'
      );

      // Phase 2
      expect(result.phases[1].numericIndex).toBe(2);
      expect(result.phases[1].title).toBe('Advanced Security Features');
      expect(result.phases[1].dependencies).toEqual(['Phase 1']);
      expect(result.phases[1].tasks).toHaveLength(2);

      // Phase 3
      expect(result.phases[2].numericIndex).toBe(3);
      expect(result.phases[2].title).toBe('OAuth Integration');
      expect(result.phases[2].dependencies).toEqual(['Phase 1', 'Phase 2']);
      expect(result.phases[2].tasks).toHaveLength(1);
    });

    test('should handle phases with no dependencies', async () => {
      const markdown = `# Goal

Build a feature.

### Phase 1: Setup

#### Goal

Initial setup.

#### Dependencies

#### Details

Setup details.

##### Task: Configure Environment

**Description:** Set up the development environment.
`;

      const result = await parseMarkdownPlan(markdown);
      expect(result.phases[0].dependencies).toEqual([]);
    });

    test('should handle phases with "None" as dependency', async () => {
      const markdown = `# Goal

Build a feature.

### Phase 1: Setup

#### Goal

Initial setup.

#### Dependencies

None

#### Details

Setup details.
`;

      const result = await parseMarkdownPlan(markdown);
      expect(result.phases[0].dependencies).toEqual([]);
    });

    test('should handle phase with no tasks', async () => {
      const markdown = `# Goal

Quick setup.

### Phase 1: Configuration

#### Goal

Configure the system.

#### Dependencies

None

#### Details

Just configuration, no specific tasks.
`;

      const result = await parseMarkdownPlan(markdown);
      expect(result.phases[0].tasks).toEqual([]);
    });
  });

  describe('Single-phase plan (implicit)', () => {
    test('should parse markdown without phase headers as single phase', async () => {
      const markdown = `# Goal

Implement a simple API endpoint.

## Details

Create a REST API endpoint for user profile retrieval.

##### Task: Create GET /user/:id endpoint

**Description:** Implement the endpoint to fetch user data by ID.

##### Task: Add validation

**Description:** Validate the user ID parameter and handle errors.
`;

      const result = await parseMarkdownPlan(markdown);

      expect(result.overallGoal).toBe('Implement a simple API endpoint.');
      expect(result.overallDetails).toBe('Create a REST API endpoint for user profile retrieval.');
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0].numericIndex).toBe(1);
      expect(result.phases[0].title).toBe('Implementation');
      expect(result.phases[0].goal).toBe('Implement a simple API endpoint.');
      expect(result.phases[0].dependencies).toEqual([]);
      expect(result.phases[0].details).toBe(
        'Create a REST API endpoint for user profile retrieval.'
      );
      expect(result.phases[0].tasks).toHaveLength(2);
      expect(result.phases[0].tasks[0].title).toBe('Create GET /user/:id endpoint');
      expect(result.phases[0].tasks[1].title).toBe('Add validation');
    });

    test('should create default task if no tasks present', async () => {
      const markdown = `# Goal

Fix a bug in the authentication system.

## Details

The login endpoint is returning incorrect error codes.
`;

      const result = await parseMarkdownPlan(markdown);

      expect(result.phases).toHaveLength(1);
      expect(result.phases[0].tasks).toHaveLength(1);
      expect(result.phases[0].tasks[0].title).toBe('Fix a bug in the authentication system.');
      expect(result.phases[0].tasks[0].description).toBe(
        'The login endpoint is returning incorrect error codes.'
      );
    });

    test('should handle plan with only goal', async () => {
      const markdown = `# Goal

Implement user authentication.
`;

      const result = await parseMarkdownPlan(markdown);

      expect(result.overallGoal).toBe('Implement user authentication.');
      expect(result.overallDetails).toBe('');
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0].goal).toBe('Implement user authentication.');
      expect(result.phases[0].details).toBe('');
      expect(result.phases[0].tasks).toHaveLength(1);
      expect(result.phases[0].tasks[0].title).toBe('Implement user authentication.');
    });
  });

  describe('Edge cases', () => {
    test('should handle empty input', async () => {
      const result = await parseMarkdownPlan('');

      expect(result.overallGoal).toBe('');
      expect(result.overallDetails).toBe('');
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0].title).toBe('Implementation');
      expect(result.phases[0].goal).toBe('Complete the implementation');
      expect(result.phases[0].tasks).toHaveLength(1);
      expect(result.phases[0].tasks[0].title).toBe('Implement feature');
    });

    test('should handle markdown with extra whitespace', async () => {
      const markdown = `# Goal

  Implement feature with extra spaces.  

## Details


This has extra whitespace everywhere.   


### Phase 1: Setup   

#### Goal

  Set things up.  

#### Dependencies

  None  

#### Details
   
Details with spaces.   

##### Task: Do something

**Description:**   Clean up spaces.   
`;

      const result = await parseMarkdownPlan(markdown);

      expect(result.overallGoal).toBe('  Implement feature with extra spaces.  ');
      expect(result.phases[0].title).toBe('Setup');
      expect(result.phases[0].goal).toBe('  Set things up.  ');
      expect(result.phases[0].tasks[0].description).toBe('Clean up spaces.');
    });

    test('should handle multi-paragraph content', async () => {
      const markdown = `# Goal

This is the first paragraph of the goal.

This is the second paragraph of the goal.

## Details

First paragraph of details.

Second paragraph of details.

### Phase 1: Implementation

#### Goal

First paragraph of phase goal.

Second paragraph of phase goal.

#### Dependencies

None

#### Details

First paragraph of phase details.

Second paragraph of phase details.

##### Task: Complex Task

**Description:** First paragraph of description.

This is a continuation of the task description.
`;

      const result = await parseMarkdownPlan(markdown);

      expect(result.overallGoal).toBe(
        'This is the first paragraph of the goal.\n\nThis is the second paragraph of the goal.'
      );
      expect(result.overallDetails).toBe(
        'First paragraph of details.\n\nSecond paragraph of details.'
      );
      expect(result.phases[0].goal).toBe(
        'First paragraph of phase goal.\n\nSecond paragraph of phase goal.'
      );
      expect(result.phases[0].details).toBe(
        'First paragraph of phase details.\n\nSecond paragraph of phase details.'
      );
      expect(result.phases[0].tasks[0].description).toBe(
        'First paragraph of description.\n\nThis is a continuation of the task description.'
      );
    });

    test('should handle missing overall details', async () => {
      const markdown = `# Goal

Implement something.

### Phase 1: Do Work

#### Goal

Get it done.

#### Dependencies

None

#### Details

Work details.
`;

      const result = await parseMarkdownPlan(markdown);

      expect(result.overallGoal).toBe('Implement something.');
      expect(result.overallDetails).toBe('');
      expect(result.phases[0].goal).toBe('Get it done.');
    });

    test('should handle phase titles with special characters', async () => {
      const markdown = `# Goal

Build system.

### Phase 1: Setup & Configuration (DB + API)

#### Goal

Set up database and API.

#### Dependencies

None

#### Details

Configure everything.
`;

      const result = await parseMarkdownPlan(markdown);

      expect(result.phases[0].title).toBe('Setup & Configuration (DB + API)');
    });

    test('should handle complex dependency lists', async () => {
      const markdown = `# Goal

Complex project.

### Phase 1: Base

#### Goal

Base setup.

#### Dependencies

None

#### Details

Base details.

### Phase 2: Advanced

#### Goal

Advanced features.

#### Dependencies

Phase 1, Phase 3 (partial), External System

#### Details

Complex dependencies.
`;

      const result = await parseMarkdownPlan(markdown);

      expect(result.phases[1].dependencies).toEqual([
        'Phase 1',
        'Phase 3 (partial)',
        'External System',
      ]);
    });
  });

  describe('Formatting variations', () => {
    test('should handle variations in task description format', async () => {
      const markdown = `# Goal

Test variations.

### Phase 1: Testing

#### Goal

Test different formats.

#### Dependencies

None

#### Details

Testing task formats.

##### Task: First Task

**Description:** Standard format.

##### Task: Second Task

**Description:** Description without space after colon.

##### Task: Third Task

**Description:** 
Description on new line.
`;

      const result = await parseMarkdownPlan(markdown);

      expect(result.phases[0].tasks).toHaveLength(3);
      expect(result.phases[0].tasks[0].description).toBe('Standard format.');
      expect(result.phases[0].tasks[1].description).toBe('Description without space after colon.');
      expect(result.phases[0].tasks[2].description).toBe('Description on new line.');
    });
  });
});
