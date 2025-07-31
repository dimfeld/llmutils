---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Ability to run, generate, prepare, or agent commands on the next ready
  dependency of a plan. - Implement Core Dependency Discovery Logic
goal: To create the backend functionality that can identify the next ready or
  pending dependency for a given parent plan.
id: 82
status: done
priority: high
dependencies: []
parent: 81
planGeneratedAt: 2025-07-29T23:21:36.332Z
promptsGeneratedAt: 2025-07-31T01:05:58.835Z
createdAt: 2025-07-29T19:19:03.441Z
updatedAt: 2025-07-31T03:34:49.445Z
tasks:
  - title: Define and Access Plan State
    description: >
      Ensure a clear and accessible method exists to retrieve the current state
      of any given plan. Since the plan state is already defined in the schema
      (pending, in_progress, done, cancelled, deferred), this task focuses on
      creating helper functions for state checking and documenting the state
      access patterns. This will build on the existing statusSchema in
      planSchema.ts and the isPlanReady function in plans.ts.
    files:
      - src/rmplan/plans/plan_state_utils.ts
      - src/rmplan/plans/plan_state_utils.test.ts
    steps:
      - prompt: >
          Create a new file src/rmplan/plans/plan_state_utils.ts with utility
          functions for checking plan states.

          Include functions like isPlanPending(), isPlanInProgress(),
          isPlanActionable() (returns true for pending/in_progress).

          Follow the TypeScript patterns from the codebase with proper JSDoc
          documentation.
        done: true
      - prompt: >
          Create corresponding tests in plan_state_utils.test.ts using Bun test
          framework.

          Test all state checking functions with various plan states.

          Follow the test patterns from find_next.test.ts.
        done: true
  - title: Implement Dependency Graph Traversal
    description: >
      Create a function that takes a plan identifier and recursively or
      iteratively finds all its direct and indirect dependencies. This includes
      both explicit dependencies (from the dependencies array) and implicit
      child relationships (plans with matching parent field). The function
      should use breadth-first search (BFS) to prioritize closer dependencies
      and handle circular dependency detection. This builds on the existing
      collectDependenciesInOrder function but adds support for parent-child
      relationships.
    files:
      - src/rmplan/plans/dependency_traversal.ts
      - src/rmplan/plans/dependency_traversal.test.ts
    steps:
      - prompt: >
          Create dependency_traversal.ts with a traversePlanDependencies
          function that performs BFS traversal.

          The function should find both explicit dependencies (from dependencies
          array) and children (plans with parent field).

          Include circular dependency detection using a visited set, similar to
          collectDependenciesInOrder.
        done: true
      - prompt: >
          Add a helper function to get all direct dependencies of a plan (both
          from dependencies array and child plans).

          This should query the allPlans map to find plans where parent equals
          the current plan ID.
        done: true
      - prompt: >
          Create comprehensive tests in dependency_traversal.test.ts covering:
          simple dependencies, parent-child relationships,

          mixed dependencies and children, circular dependency detection, and
          plans with no dependencies.

          Use temporary directories and the test patterns from
          parent_completion.test.ts.
        done: true
  - title: Create the "Find Next Ready Dependency" Function
    description: >
      Develop the main function that orchestrates the process of finding the
      next ready or pending dependency for a given parent plan. It will use the
      graph traversal logic to scan dependencies and the state-checking logic to
      evaluate them, returning the first plan that is "ready" or "pending" with
      all its dependencies met. The function should handle cases where no such
      dependency is found. This builds on the existing findNextPlan and
      isPlanReady functions but focuses on a specific parent plan's dependency
      tree.
    files:
      - src/rmplan/plans/find_next_dependency.ts
      - src/rmplan/plans/find_next_dependency.test.ts
    steps:
      - prompt: >
          Create find_next_dependency.ts with a findNextReadyDependency function
          that takes a parent plan ID and returns the next actionable
          dependency.

          Use the traversal function from dependency_traversal.ts to get
          dependencies in BFS order.

          Check each dependency using isPlanReady logic - a plan is ready if
          it's pending and all its dependencies are done.
        done: true
      - prompt: >
          Add proper TypeScript types for the return value (plan with filename
          or null).

          Include JSDoc documentation explaining the function's behavior and
          return values.

          Handle edge cases like invalid plan IDs or plans with no dependencies.
        done: true
      - prompt: >
          Export the function and any related types so they can be used by CLI
          commands in later phases.

          Follow the export patterns from find_next.ts.
        done: true
  - title: Add Comprehensive Tests for Core Logic
    description: >
      Write a suite of unit and integration tests for the dependency discovery
      function. These tests should validate its behavior with different
      dependency structures and plan states, ensuring its correctness and
      reliability before it's integrated with the CLI. Tests should cover
      various scenarios including plans with no dependencies, no ready
      dependencies, multiple ready dependencies, circular dependencies, and
      complex nested structures with both explicit dependencies and parent-child
      relationships.
    files:
      - src/rmplan/plans/find_next_dependency.test.ts
      - src/rmplan/plans/integration.test.ts
    steps:
      - prompt: >
          Enhance find_next_dependency.test.ts with tests for basic scenarios:
          finding a ready dependency,

          returning null when no dependencies exist, handling completed
          dependencies, and respecting priority order.
        done: true
      - prompt: >
          Add tests for complex scenarios: nested dependencies (dependencies of
          dependencies), mixed parent-child and explicit dependencies,

          circular dependency handling, and plans with 'maybe' priority (which
          should be skipped).
        done: true
      - prompt: >
          Create integration.test.ts that tests the complete flow with realistic
          plan structures.

          Test scenarios like a multi-phase project with interdependencies,
          proper BFS ordering, and state transitions.

          Use the test setup patterns from rmplan.integration.test.ts.
        done: true
changedFiles:
  - src/common/cleanup_registry.test.ts
  - src/common/cleanup_registry.ts
  - src/rmplan/agent_runner.test.ts
  - src/rmplan/agent_runner.ts
  - src/rmplan/commands/agent.test.ts
  - src/rmplan/commands/agent.ts
  - src/rmplan/commands/find_next_dependency.test.ts
  - src/rmplan/commands/find_next_dependency.ts
  - src/rmplan/commands/integration.test.ts
  - src/rmplan/dependency_traversal.test.ts
  - src/rmplan/dependency_traversal.ts
  - src/rmplan/executors/claude_code/agent_generator.test.ts
  - src/rmplan/executors/claude_code/agent_generator.ts
  - src/rmplan/executors/claude_code/agent_prompts.ts
  - src/rmplan/executors/claude_code/orchestrator_prompt.ts
  - src/rmplan/executors/claude_code.test.ts
  - src/rmplan/executors/claude_code.ts
  - src/rmplan/executors/copy_only.ts
  - src/rmplan/executors/copy_paste.ts
  - src/rmplan/executors/one-call.ts
  - src/rmplan/executors/types.ts
  - src/rmplan/plans/plan_state_utils.test.ts
  - src/rmplan/plans/plan_state_utils.ts
  - src/rmplan/prompt_builder.test.ts
  - src/rmplan/rmplan.ts
  - src/rmpr/main.ts
rmfilter:
  - src/rmplan
---

This phase focuses on building the fundamental logic for dependency graph traversal and state checking, completely independent of the CLI. The output of this phase will be a well-tested function or module that can take a parent plan's identifier and return the identifier of the next appropriate dependency, or indicate that none was found.

### Acceptance Criteria
- A function exists that can traverse the dependency graph of a given plan.
- The function can correctly identify plans in "ready" or "pending" states.
- The function returns the first suitable dependency found during a breadth-first traversal.
- Unit and integration tests cover various scenarios, including plans with no dependencies, no ready dependencies, and multiple ready dependencies.
