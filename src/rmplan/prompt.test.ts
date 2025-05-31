import { describe, expect, it } from 'bun:test';
import { generatePhaseStepsPrompt, type PhaseGenerationContext } from './prompt';

describe('generatePhaseStepsPrompt', () => {
  it('should generate prompt with no previous phases', () => {
    const context: PhaseGenerationContext = {
      overallProjectGoal: 'Build a task management system',
      overallProjectDetails: 'A web-based task management application with user authentication',
      currentPhaseGoal: 'Implement user authentication',
      currentPhaseDetails: 'Set up JWT-based authentication with login/logout endpoints',
      currentPhaseTasks: [
        {
          title: 'Create user model',
          description: 'Define the user schema and database model',
        },
        {
          title: 'Implement auth endpoints',
          description: 'Create login, logout, and register endpoints',
        },
      ],
      previousPhasesInfo: [],
      changedFilesFromDependencies: [],
      rmfilterArgsFromPlan: ['src/**/*.ts', '--with-imports'],
    };

    const prompt = generatePhaseStepsPrompt(context);

    // Check that the prompt contains key elements
    expect(prompt).toContain('Phase Implementation Generation');
    expect(prompt).toContain('Build a task management system');
    expect(prompt).toContain('A web-based task management application with user authentication');
    expect(prompt).toContain('Implement user authentication');
    expect(prompt).toContain('Set up JWT-based authentication with login/logout endpoints');
    expect(prompt).toContain('Task 1: Create user model');
    expect(prompt).toContain('Task 2: Implement auth endpoints');
    expect(prompt).toContain('src/**/*.ts --with-imports');

    // Should not contain previous phases section
    expect(prompt).not.toContain('Previous Completed Phases');
    expect(prompt).not.toContain('Files Changed in Previous Phases');
  });

  it('should generate prompt with previous phases', () => {
    const context: PhaseGenerationContext = {
      overallProjectGoal: 'Build a task management system',
      overallProjectDetails: 'A web-based task management application with user authentication',
      currentPhaseGoal: 'Implement task CRUD operations',
      currentPhaseDetails:
        'Create endpoints and UI for creating, reading, updating, and deleting tasks',
      currentPhaseTasks: [
        {
          title: 'Create task model',
          description: 'Define the task schema and database model',
        },
        {
          title: 'Implement CRUD endpoints',
          description: 'Create REST endpoints for task operations',
        },
      ],
      previousPhasesInfo: [
        {
          id: 'phase-123',
          title: 'Phase 1: User Authentication',
          goal: 'Implement user authentication',
          description: 'JWT-based authentication system',
        },
      ],
      changedFilesFromDependencies: [
        'src/models/user.ts',
        'src/routes/auth.ts',
        'src/middleware/auth.ts',
      ],
      rmfilterArgsFromPlan: ['src/**/*.ts', '--with-imports'],
    };

    const prompt = generatePhaseStepsPrompt(context);

    // Check previous phases section
    expect(prompt).toContain('Previous Completed Phases');
    expect(prompt).toContain('Phase 1: User Authentication (ID: phase-123)');
    expect(prompt).toContain('**Goal:** Implement user authentication');
    expect(prompt).toContain('**Description:** JWT-based authentication system');

    // Check changed files section
    expect(prompt).toContain('Files Changed in Previous Phases');
    expect(prompt).toContain('src/models/user.ts');
    expect(prompt).toContain('src/routes/auth.ts');
    expect(prompt).toContain('src/middleware/auth.ts');

    // Check current phase information
    expect(prompt).toContain('Implement task CRUD operations');
    expect(prompt).toContain(
      'Create endpoints and UI for creating, reading, updating, and deleting tasks'
    );
    expect(prompt).toContain('Task 1: Create task model');
    expect(prompt).toContain('Task 2: Implement CRUD endpoints');
  });

  it('should generate prompt with multiple previous phases', () => {
    const context: PhaseGenerationContext = {
      overallProjectGoal: 'Build a collaborative document editor',
      overallProjectDetails: 'Real-time collaborative editing with conflict resolution',
      currentPhaseGoal: 'Add collaboration features',
      currentPhaseDetails: 'Implement real-time synchronization and conflict resolution',
      currentPhaseTasks: [
        {
          title: 'Implement WebSocket connection',
          description: 'Set up WebSocket server and client connections',
        },
      ],
      previousPhasesInfo: [
        {
          id: 'phase-001',
          title: 'Phase 1: Basic Editor',
          goal: 'Create basic text editor',
          description: 'Simple text editing with save/load functionality',
        },
        {
          id: 'phase-002',
          title: 'Phase 2: User Management',
          goal: 'Add user accounts',
          description: 'User registration and authentication',
        },
      ],
      changedFilesFromDependencies: ['src/editor.ts', 'src/models/document.ts', 'src/auth.ts'],
      rmfilterArgsFromPlan: [],
    };

    const prompt = generatePhaseStepsPrompt(context);

    // Check multiple previous phases
    expect(prompt).toContain('Phase 1: Basic Editor (ID: phase-001)');
    expect(prompt).toContain('Phase 2: User Management (ID: phase-002)');
    expect(prompt).toContain('Create basic text editor');
    expect(prompt).toContain('User registration and authentication');
  });

  it('should handle empty rmfilter args', () => {
    const context: PhaseGenerationContext = {
      overallProjectGoal: 'Test project',
      overallProjectDetails: 'Test details',
      currentPhaseGoal: 'Test phase',
      currentPhaseDetails: 'Test phase details',
      currentPhaseTasks: [
        {
          title: 'Test task',
          description: 'Test description',
        },
      ],
      previousPhasesInfo: [],
      changedFilesFromDependencies: [],
      rmfilterArgsFromPlan: [],
    };

    const prompt = generatePhaseStepsPrompt(context);

    // Should handle empty rmfilter args gracefully
    expect(prompt).toContain('Consider the rmfilter arguments that will be used:');
    // When args are empty, it should end cleanly without breaking the format
    expect(prompt).toEndWith('Consider the rmfilter arguments that will be used: \n');
  });

  it('should include all required instructions and guidelines', () => {
    const context: PhaseGenerationContext = {
      overallProjectGoal: 'Test project',
      overallProjectDetails: 'Test details',
      currentPhaseGoal: 'Test phase',
      currentPhaseDetails: 'Test phase details',
      currentPhaseTasks: [
        {
          title: 'Test task',
          description: 'Test description',
        },
      ],
      previousPhasesInfo: [],
      changedFilesFromDependencies: [],
      rmfilterArgsFromPlan: [],
    };

    const prompt = generatePhaseStepsPrompt(context);

    // Check for required sections
    expect(prompt).toContain('## Instructions');
    expect(prompt).toContain('### Guidelines:');
    expect(prompt).toContain('### Output Format');

    // Check for specific guidelines
    expect(prompt).toContain('Test-Driven Development');
    expect(prompt).toContain('Incremental Progress');
    expect(prompt).toContain('Build on Previous Work');
    expect(prompt).toContain('File Selection');
    expect(prompt).toContain('Step Prompts');

    // Check for output format requirements
    expect(prompt).toContain('Output ONLY the YAML tasks array');
    expect(prompt).toContain('Ensure all fields are properly populated');
    expect(prompt).toContain('Use proper YAML syntax with correct indentation');
    expect(prompt).toContain('Multi-line prompts should use the pipe (|) character');
  });
});
