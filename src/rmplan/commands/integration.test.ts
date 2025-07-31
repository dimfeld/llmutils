import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { findNextReadyDependency } from './find_next_dependency.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { PlanSchema } from '../planSchema.js';
import yaml from 'yaml';
import { clearPlanCache } from '../plans.js';

describe('findNextReadyDependency integration tests', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Create temporary directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'find-next-dep-integration-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up the temporary directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function createPlanFile(plan: PlanSchema & { filename: string }) {
    const filePath = path.join(tasksDir, plan.filename);

    // Create a proper plan object according to the schema
    const planData: any = {
      id: plan.id,
      title: plan.title,
      goal: plan.goal || 'Test goal',
      status: plan.status || 'pending',
      tasks: plan.tasks || [],
    };

    // Only add optional fields if they exist
    if (plan.dependencies && plan.dependencies.length > 0) {
      planData.dependencies = plan.dependencies;
    }
    if (plan.parent !== undefined) {
      planData.parent = plan.parent;
    }
    if (plan.priority) {
      planData.priority = plan.priority;
    }

    // Write as YAML
    const yamlContent = yaml.stringify(planData);
    await fs.writeFile(filePath, yamlContent, 'utf-8');
  }

  test('multi-phase project with complex interdependencies', async () => {
    // Create a realistic multi-phase project structure:
    // Phase 1: Research and Design (1)
    //   - Research existing solutions (2)
    //   - Design architecture (3) [depends on 2]
    //   - Create technical spec (4) [depends on 3]
    // Phase 2: Implementation (5) [depends on 1]
    //   - Backend development (6) [depends on 4]
    //     - API design (7)
    //     - Database schema (8)
    //     - Core services (9) [depends on 7, 8]
    //   - Frontend development (10) [depends on 4]
    //     - UI components (11)
    //     - State management (12)
    //     - Integration (13) [depends on 9, 11, 12]
    // Phase 3: Testing and Deployment (14) [depends on 5]
    //   - Unit tests (15) [depends on 6, 10]
    //   - Integration tests (16) [depends on 15]
    //   - Deployment setup (17) [depends on 16]

    // Phase 1: Research and Design
    await createPlanFile({
      id: 1,
      title: 'Phase 1: Research and Design',
      filename: '1-research-design.yml',
      status: 'in_progress',
      priority: 'high',
      tasks: [{ title: 'Coordinate research and design phase', description: 'Oversee phase 1' }],
    });

    await createPlanFile({
      id: 2,
      title: 'Research existing solutions',
      filename: '2-research.yml',
      status: 'done',
      parent: 1,
      priority: 'high',
      tasks: [{ title: 'Research task', description: 'Analyze competitors', done: true }],
    });

    await createPlanFile({
      id: 3,
      title: 'Design architecture',
      filename: '3-design-arch.yml',
      status: 'done',
      parent: 1,
      dependencies: [2],
      priority: 'high',
      tasks: [{ title: 'Architecture design', description: 'Create system design', done: true }],
    });

    await createPlanFile({
      id: 4,
      title: 'Create technical spec',
      filename: '4-tech-spec.yml',
      status: 'pending',
      parent: 1,
      dependencies: [3],
      priority: 'medium',
      tasks: [
        { title: 'Write technical specification', description: 'Document all technical details' },
      ],
    });

    // Phase 2: Implementation
    await createPlanFile({
      id: 5,
      title: 'Phase 2: Implementation',
      filename: '5-implementation.yml',
      status: 'pending',
      dependencies: [1],
      priority: 'urgent',
      tasks: [{ title: 'Coordinate implementation phase', description: 'Oversee phase 2' }],
    });

    await createPlanFile({
      id: 6,
      title: 'Backend development',
      filename: '6-backend.yml',
      status: 'pending',
      parent: 5,
      dependencies: [4],
      priority: 'high',
      tasks: [{ title: 'Develop backend', description: 'Build server-side components' }],
    });

    await createPlanFile({
      id: 7,
      title: 'API design',
      filename: '7-api-design.yml',
      status: 'pending',
      parent: 6,
      priority: 'high',
      tasks: [{ title: 'Design REST API', description: 'Define endpoints and contracts' }],
    });

    await createPlanFile({
      id: 8,
      title: 'Database schema',
      filename: '8-db-schema.yml',
      status: 'pending',
      parent: 6,
      priority: 'medium',
      tasks: [{ title: 'Design database', description: 'Create schema and migrations' }],
    });

    await createPlanFile({
      id: 9,
      title: 'Core services',
      filename: '9-core-services.yml',
      status: 'pending',
      parent: 6,
      dependencies: [7, 8],
      priority: 'low',
      tasks: [{ title: 'Implement services', description: 'Build business logic' }],
    });

    await createPlanFile({
      id: 10,
      title: 'Frontend development',
      filename: '10-frontend.yml',
      status: 'pending',
      parent: 5,
      dependencies: [4],
      priority: 'medium',
      tasks: [{ title: 'Develop frontend', description: 'Build client-side application' }],
    });

    await createPlanFile({
      id: 11,
      title: 'UI components',
      filename: '11-ui-components.yml',
      status: 'pending',
      parent: 10,
      priority: 'low',
      tasks: [{ title: 'Build UI library', description: 'Create reusable components' }],
    });

    await createPlanFile({
      id: 12,
      title: 'State management',
      filename: '12-state-mgmt.yml',
      status: 'pending',
      parent: 10,
      priority: 'maybe', // This should be skipped
      tasks: [{ title: 'Setup state management', description: 'Configure Redux/MobX' }],
    });

    await createPlanFile({
      id: 13,
      title: 'Integration',
      filename: '13-integration.yml',
      status: 'pending',
      parent: 10,
      dependencies: [9, 11, 12],
      tasks: [{ title: 'Integrate systems', description: 'Connect frontend to backend' }],
    });

    // Phase 3: Testing and Deployment
    await createPlanFile({
      id: 14,
      title: 'Phase 3: Testing and Deployment',
      filename: '14-testing-deployment.yml',
      status: 'pending',
      dependencies: [5],
      priority: 'low',
      tasks: [{ title: 'Coordinate testing and deployment', description: 'Oversee phase 3' }],
    });

    await createPlanFile({
      id: 15,
      title: 'Unit tests',
      filename: '15-unit-tests.yml',
      status: 'pending',
      parent: 14,
      dependencies: [6, 10],
      tasks: [{ title: 'Write unit tests', description: 'Test individual components' }],
    });

    await createPlanFile({
      id: 16,
      title: 'Integration tests',
      filename: '16-integration-tests.yml',
      status: 'pending',
      parent: 14,
      dependencies: [15],
      tasks: [{ title: 'Write integration tests', description: 'Test system integration' }],
    });

    await createPlanFile({
      id: 17,
      title: 'Deployment setup',
      filename: '17-deployment.yml',
      status: 'pending',
      parent: 14,
      dependencies: [16],
      tasks: [{ title: 'Setup deployment', description: 'Configure CI/CD' }],
    });

    // Test from root of Phase 1
    const result = await findNextReadyDependency(1, tasksDir);

    // Should find plan 4 (Create technical spec) as it's the only pending plan in Phase 1
    // with all dependencies completed
    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(4);
    expect(result.plan?.title).toBe('Create technical spec');
  });

  test('BFS ordering with multiple branches', async () => {
    // Create a tree structure to verify BFS ordering:
    //        1
    //      /   \
    //     2     3
    //    / \   / \
    //   4   5 6   7
    //  /     \
    // 8       9

    await createPlanFile({
      id: 1,
      title: 'Root',
      filename: '1-root.yml',
      status: 'in_progress',
      dependencies: [2, 3],
      tasks: [{ title: 'Root task', description: 'Starting point' }],
    });

    // Level 1
    await createPlanFile({
      id: 2,
      title: 'Left Branch',
      filename: '2-left.yml',
      status: 'done',
      dependencies: [4, 5],
      tasks: [{ title: 'Left task', description: 'Completed', done: true }],
    });

    await createPlanFile({
      id: 3,
      title: 'Right Branch',
      filename: '3-right.yml',
      status: 'done',
      dependencies: [6, 7],
      tasks: [{ title: 'Right task', description: 'Completed', done: true }],
    });

    // Level 2
    await createPlanFile({
      id: 4,
      title: 'Left-Left',
      filename: '4-left-left.yml',
      status: 'pending',
      dependencies: [8],
      priority: 'low',
      tasks: [{ title: 'LL task', description: 'Pending' }],
    });

    await createPlanFile({
      id: 5,
      title: 'Left-Right',
      filename: '5-left-right.yml',
      status: 'pending',
      dependencies: [9],
      priority: 'medium',
      tasks: [{ title: 'LR task', description: 'Pending' }],
    });

    await createPlanFile({
      id: 6,
      title: 'Right-Left',
      filename: '6-right-left.yml',
      status: 'pending',
      priority: 'high',
      tasks: [{ title: 'RL task', description: 'Ready to start' }],
    });

    await createPlanFile({
      id: 7,
      title: 'Right-Right',
      filename: '7-right-right.yml',
      status: 'pending',
      priority: 'urgent',
      tasks: [{ title: 'RR task', description: 'Very urgent' }],
    });

    // Level 3
    await createPlanFile({
      id: 8,
      title: 'Deep Left',
      filename: '8-deep-left.yml',
      status: 'pending',
      tasks: [{ title: 'DL task', description: 'Deep dependency' }],
    });

    await createPlanFile({
      id: 9,
      title: 'Deep Right',
      filename: '9-deep-right.yml',
      status: 'pending',
      tasks: [{ title: 'DR task', description: 'Deep dependency' }],
    });

    const result = await findNextReadyDependency(1, tasksDir);

    // BFS should find level 2 nodes first, then sort by priority
    // Plan 7 (Right-Right) has urgent priority and no dependencies
    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(7);
    expect(result.plan?.title).toBe('Right-Right');
  });

  test('state transitions with changing dependencies', async () => {
    // Test how the system handles state transitions
    // Initial state: 1 -> 2 -> 3, where 2 is pending
    await createPlanFile({
      id: 1,
      title: 'Main Project',
      filename: '1-main.yml',
      status: 'in_progress',
      dependencies: [2],
      tasks: [{ title: 'Main task', description: 'Primary work' }],
    });

    await createPlanFile({
      id: 2,
      title: 'Step 1',
      filename: '2-step1.yml',
      status: 'pending',
      dependencies: [3],
      tasks: [{ title: 'Step 1 task', description: 'First step' }],
    });

    await createPlanFile({
      id: 3,
      title: 'Prerequisite',
      filename: '3-prereq.yml',
      status: 'pending',
      tasks: [{ title: 'Prereq task', description: 'Must be done first' }],
    });

    // First check - should find plan 3 (no dependencies)
    let result = await findNextReadyDependency(1, tasksDir);
    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(3);

    // Simulate completing plan 3
    await createPlanFile({
      id: 3,
      title: 'Prerequisite',
      filename: '3-prereq.yml',
      status: 'done',
      tasks: [{ title: 'Prereq task', description: 'Must be done first', done: true }],
    });

    // Clear cache to pick up the updated plan
    clearPlanCache();

    // Second check - now plan 2 should be ready
    result = await findNextReadyDependency(1, tasksDir);
    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(2);

    // Simulate starting plan 2
    await createPlanFile({
      id: 2,
      title: 'Step 1',
      filename: '2-step1.yml',
      status: 'in_progress',
      dependencies: [3],
      tasks: [{ title: 'Step 1 task', description: 'First step' }],
    });

    // Clear cache to pick up the updated plan
    clearPlanCache();

    // Third check - should still find plan 2 (in_progress)
    result = await findNextReadyDependency(1, tasksDir);
    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(2);
    expect(result.message).toContain('Found in-progress plan');
  });

  test('mixed parent-child and explicit dependencies', async () => {
    // Create a complex structure mixing both dependency types
    // Parent-child relationships form the main structure
    // Explicit dependencies add cross-cutting concerns

    await createPlanFile({
      id: 1,
      title: 'Application Development',
      filename: '1-app-dev.yml',
      status: 'in_progress',
      tasks: [{ title: 'Develop application', description: 'Main development' }],
    });

    // Security module (child of 1)
    await createPlanFile({
      id: 2,
      title: 'Security Module',
      filename: '2-security.yml',
      status: 'pending',
      parent: 1,
      priority: 'high',
      tasks: [{ title: 'Implement security', description: 'Add authentication' }],
    });

    // Data module (child of 1)
    await createPlanFile({
      id: 3,
      title: 'Data Module',
      filename: '3-data.yml',
      status: 'done',
      parent: 1,
      tasks: [{ title: 'Data layer', description: 'Database integration', done: true }],
    });

    // API module (child of 1, depends on both security and data)
    await createPlanFile({
      id: 4,
      title: 'API Module',
      filename: '4-api.yml',
      status: 'pending',
      parent: 1,
      dependencies: [2, 3], // Needs both security and data
      priority: 'medium',
      tasks: [{ title: 'Build API', description: 'REST endpoints' }],
    });

    // UI module (child of 1)
    await createPlanFile({
      id: 5,
      title: 'UI Module',
      filename: '5-ui.yml',
      status: 'pending',
      parent: 1,
      priority: 'low',
      tasks: [{ title: 'Build UI', description: 'User interface' }],
    });

    // Integration (child of 1, depends on API and UI)
    await createPlanFile({
      id: 6,
      title: 'Integration',
      filename: '6-integration.yml',
      status: 'pending',
      parent: 1,
      dependencies: [4, 5],
      priority: 'urgent',
      tasks: [{ title: 'Integrate modules', description: 'Connect everything' }],
    });

    const result = await findNextReadyDependency(1, tasksDir);

    // Should find Security Module (id: 2) because:
    // - It's a direct child (via parent field)
    // - It has no dependencies
    // - It has high priority (higher than UI which also has no dependencies)
    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(2);
    expect(result.plan?.title).toBe('Security Module');
  });

  test('circular dependency with mixed relationships', async () => {
    // Create a true circular dependency scenario
    // 1 (parent) has children 2 and 3
    // 2 depends on 3, 3 depends on 2 (direct cycle)

    await createPlanFile({
      id: 1,
      title: 'Parent with Circular Children',
      filename: '1-parent.yml',
      status: 'in_progress',
      tasks: [{ title: 'Parent task', description: 'Has circular children' }],
    });

    await createPlanFile({
      id: 2,
      title: 'Child A',
      filename: '2-child-a.yml',
      status: 'pending',
      parent: 1,
      dependencies: [3], // Depends on sibling
      tasks: [{ title: 'Child A task', description: 'Depends on Child B' }],
    });

    await createPlanFile({
      id: 3,
      title: 'Child B',
      filename: '3-child-b.yml',
      status: 'pending',
      parent: 1,
      dependencies: [2], // Depends back on Child A - creating a cycle
      tasks: [{ title: 'Child B task', description: 'Depends on Child A' }],
    });

    const result = await findNextReadyDependency(1, tasksDir);

    // Should handle the circular dependency gracefully
    // None of the plans can be started due to circular dependencies
    expect(result.plan).toBeNull();
    expect(result.message).toContain('No ready or pending dependencies found');
  });

  test('large project with realistic priority distribution', async () => {
    // Create a large project to test performance and correct prioritization
    const phases = [
      { id: 1, title: 'Project Root', status: 'in_progress', priority: undefined },
      { id: 2, title: 'Phase 1', parent: 1, status: 'done', priority: 'high' },
      { id: 3, title: 'Phase 2', parent: 1, status: 'in_progress', priority: 'urgent' },
      {
        id: 4,
        title: 'Phase 3',
        parent: 1,
        status: 'pending',
        priority: 'medium',
        dependencies: [2],
      },
      {
        id: 5,
        title: 'Phase 4',
        parent: 1,
        status: 'pending',
        priority: 'low',
        dependencies: [3, 4],
      },
    ];

    // Create phase plans
    for (const phase of phases) {
      await createPlanFile({
        id: phase.id,
        title: phase.title,
        filename: `${phase.id}-${phase.title.toLowerCase().replace(/\s+/g, '-')}.yml`,
        status: phase.status as any,
        parent: phase.parent,
        dependencies: phase.dependencies,
        priority: phase.priority as any,
        tasks: [{ title: `${phase.title} task`, description: `Work for ${phase.title}` }],
      });
    }

    // Add many subtasks to Phase 3 with various priorities
    const subtaskPriorities = ['urgent', 'high', 'medium', 'low', 'maybe', undefined];
    for (let i = 0; i < 20; i++) {
      const priority = subtaskPriorities[i % subtaskPriorities.length];
      await createPlanFile({
        id: 10 + i,
        title: `Subtask ${i + 1}`,
        filename: `${10 + i}-subtask-${i + 1}.yml`,
        status: 'pending',
        parent: 3,
        priority: priority as any,
        tasks: [{ title: `Subtask ${i + 1}`, description: `Subtask work ${i + 1}` }],
      });
    }

    const result = await findNextReadyDependency(1, tasksDir);

    // Should find Phase 3 first (in_progress with urgent priority)
    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe(3);
    expect(result.plan?.title).toBe('Phase 2');
    expect(result.message).toContain('Found in-progress plan');

    // Now check from Phase 3 to find its subtasks
    const subtaskResult = await findNextReadyDependency(3, tasksDir);

    // Should find the first urgent subtask (id: 10, since i=0 gives 'urgent')
    expect(subtaskResult.plan).not.toBeNull();
    expect(subtaskResult.plan?.id).toBe(10);
    expect(subtaskResult.plan?.priority).toBe('urgent');
  });
});
