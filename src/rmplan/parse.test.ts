import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';
import { $ } from 'bun';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import yaml from 'yaml';
import type { PhaseSchema } from './planSchema.ts';

describe('rmplan parse command', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-parse-test-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    // Clean up
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('parses multi-phase markdown plan', async () => {
    // Create sample markdown file
    const markdownContent = `# Goal

Implement a new user authentication system with OAuth support.

## Details

This feature will add secure authentication using OAuth providers (Google, GitHub) and JWT tokens. The implementation will be done in three phases: backend setup, frontend integration, and testing/documentation.

### Phase 1: Backend Authentication Setup

#### Goal

Set up backend authentication infrastructure

#### Dependencies

None

#### Details

Implement OAuth providers, JWT token generation, and user session management.

##### Task: Set up OAuth configuration

**Description:** Configure OAuth providers (Google, GitHub) and set up environment variables for OAuth credentials.

##### Task: Implement JWT token handling

**Description:** Create JWT generation and validation logic. Set up token refresh mechanism.

### Phase 2: Frontend Integration

#### Goal

Integrate authentication into the frontend

#### Dependencies

Phase 1

#### Details

Create login/logout UI components and integrate with backend authentication endpoints.

##### Task: Create authentication UI components

**Description:** Design and implement login form. Create OAuth provider buttons.

##### Task: Implement authentication flow

**Description:** Connect frontend to backend auth endpoints. Handle token storage and refresh.

### Phase 3: Testing and Documentation

#### Goal

Comprehensive testing and documentation

#### Dependencies

Phase 1, Phase 2

#### Details

Write unit tests, integration tests, and user documentation.

##### Task: Write tests

**Description:** Unit tests for auth components. Integration tests for full auth flow.

##### Task: Create documentation

**Description:** API documentation. User guide for authentication.

## rmfilter
- src/auth/**/*.ts
- src/components/auth/**/*.tsx
`;

    await fs.writeFile('feature_plan.md', markdownContent);

    // Run the parse command
    const rmplanPath = path.join(originalCwd, 'src/rmplan/rmplan.ts');
    const result =
      await $`bun run ${rmplanPath} parse --input feature_plan.md --output-dir ./parsed_plan`.quiet();

    expect(result.exitCode).toBe(0);

    // Verify output directory structure
    const files = await fs.readdir('./parsed_plan');
    expect(files.length).toBe(1); // Should have one project directory

    const projectDir = files[0];
    expect(projectDir).toMatch(/^[a-z0-9-]+$/); // Valid project ID format

    // Check phase files
    const phaseFiles = await fs.readdir(path.join('./parsed_plan', projectDir));
    expect(phaseFiles.sort()).toEqual(['phase_1.yaml', 'phase_2.yaml', 'phase_3.yaml']);

    // Verify phase content
    const phase1Content = await fs.readFile(
      path.join('./parsed_plan', projectDir, 'phase_1.yaml'),
      'utf-8'
    );
    const phase1: PhaseSchema = yaml.parse(phase1Content.split('\n').slice(1).join('\n')); // Skip schema comment

    expect(phase1.goal).toBe('Set up backend authentication infrastructure');
    expect(phase1.details).toContain('OAuth providers, JWT token generation');
    expect(phase1.dependencies).toEqual([]);
    expect(phase1.tasks.length).toBe(2);
    expect(phase1.tasks[0].title).toBe('Set up OAuth configuration');
    expect(phase1.rmfilter).toEqual([]);
    expect(phase1.status).toBe('pending');

    // Verify phase 2 has correct dependencies
    const phase2Content = await fs.readFile(
      path.join('./parsed_plan', projectDir, 'phase_2.yaml'),
      'utf-8'
    );
    const phase2: PhaseSchema = yaml.parse(phase2Content.split('\n').slice(1).join('\n'));

    expect(phase2.dependencies.length).toBe(1);
    expect(phase2.dependencies[0]).toMatch(new RegExp(`^${projectDir}-1$`));

    // Verify phase 3 has correct dependencies
    const phase3Content = await fs.readFile(
      path.join('./parsed_plan', projectDir, 'phase_3.yaml'),
      'utf-8'
    );
    const phase3: PhaseSchema = yaml.parse(phase3Content.split('\n').slice(1).join('\n'));

    expect(phase3.dependencies.length).toBe(2);
    expect(phase3.dependencies).toContain(`${projectDir}-1`);
    expect(phase3.dependencies).toContain(`${projectDir}-2`);
  });

  test('parses single-phase markdown plan', async () => {
    const markdownContent = `# Goal

Fix bug in user profile page

## Details

The user profile page is not displaying the correct email address.

### Phase 1: Fix Profile Bug

#### Goal

Fix the email display bug

#### Dependencies

None

#### Details

Debug and fix the issue with email not showing correctly on profile page.

##### Task: Debug the issue

**Description:** Investigate why email is not displayed. Check API response and frontend rendering.

##### Task: Implement fix

**Description:** Fix the bug in the profile component. Add proper error handling.
`;

    await fs.writeFile('bug_fix.md', markdownContent);

    const rmplanPath = path.join(originalCwd, 'src/rmplan/rmplan.ts');
    const result =
      await $`bun run ${rmplanPath} parse --input bug_fix.md --output-dir ./parsed_plan`.quiet();

    expect(result.exitCode).toBe(0);

    const files = await fs.readdir('./parsed_plan');
    expect(files.length).toBe(1);

    const projectDir = files[0];
    const phaseFiles = await fs.readdir(path.join('./parsed_plan', projectDir));
    expect(phaseFiles).toEqual(['phase_1.yaml']);

    const phase1Content = await fs.readFile(
      path.join('./parsed_plan', projectDir, 'phase_1.yaml'),
      'utf-8'
    );
    const phase1: PhaseSchema = yaml.parse(phase1Content.split('\n').slice(1).join('\n'));

    expect(phase1.goal).toBe('Fix the email display bug');
    expect(phase1.tasks.length).toBe(2);
  });

  test('uses explicit project ID when provided', async () => {
    const markdownContent = `# Goal

Test project

## Details

Test project details

### Phase 1: Test Phase

#### Goal

Test phase

#### Dependencies

None

#### Details

Test phase details

##### Task: Test task

**Description:** Test description
`;

    await fs.writeFile('test.md', markdownContent);

    const customProjectId = 'my-custom-project-id';
    const rmplanPath = path.join(originalCwd, 'src/rmplan/rmplan.ts');
    const result =
      await $`bun run ${rmplanPath} parse --input test.md --output-dir ./parsed_plan --project-id ${customProjectId}`.quiet();

    expect(result.exitCode).toBe(0);

    const files = await fs.readdir('./parsed_plan');
    expect(files).toEqual([customProjectId]);

    const phaseFiles = await fs.readdir(path.join('./parsed_plan', customProjectId));
    expect(phaseFiles).toEqual(['phase_1.yaml']);

    const phase1Content = await fs.readFile(
      path.join('./parsed_plan', customProjectId, 'phase_1.yaml'),
      'utf-8'
    );
    const phase1: PhaseSchema = yaml.parse(phase1Content.split('\n').slice(1).join('\n'));

    expect(phase1.id).toBe(`${customProjectId}-1`);
  });

  test.skip('generates project ID from issue', async () => {
    // SKIPPED: Mocking Octokit requires module mocking before imports
    // This would need to be tested in an isolated test file or with a different approach
    // Mock the Octokit module
    const mockOctokit = {
      rest: {
        issues: {
          get: mock(() =>
            Promise.resolve({
              data: {
                url: 'https://github.com/owner/repo/issues/123',
                number: 123,
                title: 'Add User Authentication Feature',
                body: 'We need OAuth support',
                state: 'open',
              },
            })
          ),
          listComments: mock(() =>
            Promise.resolve({
              data: [],
            })
          ),
        },
      },
    };

    mock.module('octokit', () => ({
      Octokit: mock(() => mockOctokit),
    }));

    const markdownContent = `# Goal

Test project

## Details

Test project details

### Phase 1: Test Phase

#### Goal

Test phase

#### Dependencies

None

#### Details

Test phase details

##### Task: Test task

**Description:** Test description
`;

    await fs.writeFile('test.md', markdownContent);

    const rmplanPath = path.join(originalCwd, 'src/rmplan/rmplan.ts');
    const result =
      await $`bun run ${rmplanPath} parse --input test.md --output-dir ./parsed_plan --issue https://github.com/owner/repo/issues/123`.quiet();

    expect(result.exitCode).toBe(0);

    const files = await fs.readdir('./parsed_plan');
    expect(files.length).toBe(1);

    const projectDir = files[0];
    expect(projectDir).toBe('issue-123-add-user-authentication-feature');

    const phase1Content = await fs.readFile(
      path.join('./parsed_plan', projectDir, 'phase_1.yaml'),
      'utf-8'
    );
    const phase1: PhaseSchema = yaml.parse(phase1Content.split('\n').slice(1).join('\n'));

    expect(phase1.issue).toEqual(['https://github.com/owner/repo/issues/123']);
  });

  test('detects circular dependencies', async () => {
    const markdownContent = `# Goal

Test circular dependencies

## Details

Testing circular dependency detection

### Phase 1: First Phase

#### Goal

First phase

#### Dependencies

Phase 3

#### Details

First phase details

##### Task: Task 1

**Description:** Description

### Phase 2: Second Phase

#### Goal

Second phase

#### Dependencies

Phase 1

#### Details

Second phase details

##### Task: Task 2

**Description:** Description

### Phase 3: Third Phase

#### Goal

Third phase

#### Dependencies

Phase 2

#### Details

Third phase details

##### Task: Task 3

**Description:** Description
`;

    await fs.writeFile('circular.md', markdownContent);

    // The command should still succeed but output a warning
    const rmplanPath = path.join(originalCwd, 'src/rmplan/rmplan.ts');
    const result =
      await $`bun run ${rmplanPath} parse --input circular.md --output-dir ./parsed_plan`.quiet();

    expect(result.exitCode).toBe(0);

    // Verify files are still created despite circular dependency
    const files = await fs.readdir('./parsed_plan');
    expect(files.length).toBe(1);

    const projectDir = files[0];
    const phaseFiles = await fs.readdir(path.join('./parsed_plan', projectDir));
    expect(phaseFiles.sort()).toEqual(['phase_1.yaml', 'phase_2.yaml', 'phase_3.yaml']);
  });

  test('handles malformed markdown gracefully', async () => {
    // Create a malformed markdown without Goal section
    const markdownContent = `This is not a properly formatted plan.

### Random Phase
No proper structure here.

## Another section
Missing required fields.
`;

    await fs.writeFile('malformed.md', markdownContent);

    // The parser will create a single-phase fallback
    const rmplanPath = path.join(originalCwd, 'src/rmplan/rmplan.ts');
    const result =
      await $`bun run ${rmplanPath} parse --input malformed.md --output-dir ./parsed_plan`
        .quiet()
        .nothrow();

    expect(result.exitCode).toBe(0);

    // Verify a single phase was created with fallback content
    const files = await fs.readdir('./parsed_plan');
    expect(files.length).toBe(1);

    const projectDir = files[0];
    const phaseFiles = await fs.readdir(path.join('./parsed_plan', projectDir));
    expect(phaseFiles).toEqual(['phase_1.yaml']);

    const phase1Content = await fs.readFile(
      path.join('./parsed_plan', projectDir, 'phase_1.yaml'),
      'utf-8'
    );
    const phase1: PhaseSchema = yaml.parse(phase1Content.split('\n').slice(1).join('\n'));

    // Check fallback values
    expect(phase1.goal).toBe('Complete the implementation'); // Default fallback goal
    expect(phase1.tasks.length).toBe(1); // Default task created
    expect(phase1.tasks[0].title).toBe('Implement feature'); // Default task title
  });

  test('handles missing dependencies correctly', async () => {
    const markdownContent = `# Goal

Test missing dependencies

## Details

Testing handling of missing dependencies

### Phase 1: First Phase

#### Goal

First phase

#### Dependencies

None

#### Details

First phase details

##### Task: Task 1

**Description:** Description

### Phase 2: Second Phase

#### Goal

Second phase

#### Dependencies

Phase 1, Phase 5

#### Details

Second phase details

##### Task: Task 2

**Description:** Description
`;

    await fs.writeFile('missing_deps.md', markdownContent);

    const rmplanPath = path.join(originalCwd, 'src/rmplan/rmplan.ts');
    const result =
      await $`bun run ${rmplanPath} parse --input missing_deps.md --output-dir ./parsed_plan`.quiet();

    expect(result.exitCode).toBe(0);

    const files = await fs.readdir('./parsed_plan');
    const projectDir = files[0];

    const phase2Content = await fs.readFile(
      path.join('./parsed_plan', projectDir, 'phase_2.yaml'),
      'utf-8'
    );
    const phase2: PhaseSchema = yaml.parse(phase2Content.split('\n').slice(1).join('\n'));

    // Should only have the valid dependency
    expect(phase2.dependencies.length).toBe(1);
    expect(phase2.dependencies[0]).toMatch(/-1$/);
  });

  test('validates YAML schema compliance', async () => {
    const markdownContent = `# Goal

Test schema validation

## Details

Testing schema validation with all fields

### Phase 1: Test Phase

#### Goal

Test phase with all fields

#### Dependencies

None

#### Details

Detailed description for testing

##### Task: Complete task

**Description:** Task with full description. Multiple lines of details.
`;

    await fs.writeFile('schema_test.md', markdownContent);

    const rmplanPath = path.join(originalCwd, 'src/rmplan/rmplan.ts');
    const result =
      await $`bun run ${rmplanPath} parse --input schema_test.md --output-dir ./parsed_plan`.quiet();

    expect(result.exitCode).toBe(0);

    const files = await fs.readdir('./parsed_plan');
    const projectDir = files[0];

    const phase1Content = await fs.readFile(
      path.join('./parsed_plan', projectDir, 'phase_1.yaml'),
      'utf-8'
    );

    // Verify schema comment is present
    expect(phase1Content).toContain(
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json'
    );

    // Parse and validate structure
    const phase1: PhaseSchema = yaml.parse(phase1Content.split('\n').slice(1).join('\n'));

    // Check all required fields
    expect(phase1.id).toMatch(/^[a-z0-9-]+-1$/);
    expect(phase1.goal).toBeTruthy();
    expect(phase1.details).toBeTruthy();
    expect(phase1.tasks).toBeInstanceOf(Array);
    expect(phase1.status).toBe('pending');
    expect(phase1.priority).toBe('unknown');
    expect(phase1.dependencies).toBeInstanceOf(Array);
    expect(phase1.planGeneratedAt).toBeTruthy();
    expect(phase1.createdAt).toBeTruthy();
    expect(phase1.updatedAt).toBeTruthy();

    // Verify task structure
    const task = phase1.tasks[0];
    expect(task.title).toBe('Complete task');
    expect(task.description).toContain('Task with full description');
    expect(task.files).toBeInstanceOf(Array);
    expect(task.include_imports).toBe(false);
    expect(task.include_importers).toBe(false);
    expect(task.steps).toBeInstanceOf(Array);
  });
});
