import { describe, test, expect } from 'bun:test';
import { getImplementerPrompt, getTesterPrompt, getReviewerPrompt } from './agent_prompts.ts';

describe('Agent Prompts', () => {
  const sampleSingleTask = `## Current Task: Implement user authentication

Description: Add a new authentication system with login and logout functionality.

This task involves:
- Creating authentication middleware
- Adding login/logout routes
- Implementing session management`;

  const sampleMultipleTasks = `## Current Tasks to Implement:

**Important**: When thinking about these tasks, consider that some part of them may have already been completed by an overeager engineer implementing the previous step. If you look at a file and it seems like a change has already been done, that is ok; just move on and don't try to make the edit again.

The current tasks to implement are:
- [1] Create authentication middleware to handle user sessions and validate tokens
- [2] Add login and logout API routes that integrate with the authentication system  
- [3] Implement session management with proper security measures
- [4] Add user registration functionality with input validation`;

  describe('getImplementerPrompt', () => {
    test('returns correct AgentDefinition structure for single task', () => {
      const result = getImplementerPrompt(sampleSingleTask);

      expect(result).toMatchObject({
        name: 'implementer',
        description:
          'Implements the requested functionality following project standards and patterns',
        prompt: expect.any(String),
      });
    });

    test('returns correct AgentDefinition structure for multiple tasks', () => {
      const result = getImplementerPrompt(sampleMultipleTasks);

      expect(result).toMatchObject({
        name: 'implementer',
        description:
          'Implements the requested functionality following project standards and patterns',
        prompt: expect.any(String),
      });
    });

    test('includes context content in prompt', () => {
      const result = getImplementerPrompt(sampleSingleTask);

      expect(result.prompt).toContain(sampleSingleTask);
    });

    test('contains batch-handling instructions for multiple tasks', () => {
      const result = getImplementerPrompt(sampleMultipleTasks);

      // Check for key batch-handling instructions
      expect(result.prompt).toContain('Handling Multiple Tasks');
      expect(result.prompt).toContain('Work on them efficiently by considering shared code');
      expect(result.prompt).toContain('Avoid duplicating similar logic across different tasks');
      expect(result.prompt).toContain('Consider the interdependencies between tasks');
      expect(result.prompt).toContain('Ensure that all tasks work together harmoniously');
    });

    test('maintains backward compatibility with single task scenarios', () => {
      const result = getImplementerPrompt(sampleSingleTask);

      // Should still contain core implementer instructions
      expect(result.prompt).toContain('Your Primary Responsibilities');
      expect(result.prompt).toContain('Implement the requested functionality');
      expect(result.prompt).toContain('Follow all coding standards');
      expect(result.prompt).toContain('Key Guidelines');
    });

    test('includes proper guidance for both single and multiple tasks', () => {
      const singleResult = getImplementerPrompt(sampleSingleTask);
      const multiResult = getImplementerPrompt(sampleMultipleTasks);

      // Both should have the same structure and guidelines
      expect(singleResult.prompt).toContain(
        'You may receive a single task or multiple related tasks'
      );
      expect(multiResult.prompt).toContain(
        'You may receive a single task or multiple related tasks'
      );

      // Both should have core implementation guidance
      expect(singleResult.prompt).toContain('Code Quality');
      expect(multiResult.prompt).toContain('Code Quality');
    });
  });

  describe('getTesterPrompt', () => {
    test('returns correct AgentDefinition structure for single task', () => {
      const result = getTesterPrompt(sampleSingleTask);

      expect(result).toMatchObject({
        name: 'tester',
        description:
          'Analyzes existing tests and ensures comprehensive test coverage for the implemented code',
        prompt: expect.any(String),
      });
    });

    test('returns correct AgentDefinition structure for multiple tasks', () => {
      const result = getTesterPrompt(sampleMultipleTasks);

      expect(result).toMatchObject({
        name: 'tester',
        description:
          'Analyzes existing tests and ensures comprehensive test coverage for the implemented code',
        prompt: expect.any(String),
      });
    });

    test('includes context content in prompt', () => {
      const result = getTesterPrompt(sampleSingleTask);

      expect(result.prompt).toContain(sampleSingleTask);
    });

    test('contains batch-testing instructions for multiple tasks', () => {
      const result = getTesterPrompt(sampleMultipleTasks);

      // Check for key batch-testing instructions
      expect(result.prompt).toContain('Handling Multiple Tasks');
      expect(result.prompt).toContain(
        'Create comprehensive tests that cover all functionality from all provided tasks'
      );
      expect(result.prompt).toContain('Look for integration points between different tasks');
      expect(result.prompt).toContain('Test the complete workflow across all implemented tasks');
      expect(result.prompt).toContain(
        'Ensure test coverage spans the entire batch of functionality'
      );
      expect(result.prompt).toContain('Create tests that verify tasks work together correctly');
    });

    test('maintains core testing guidelines', () => {
      const result = getTesterPrompt(sampleSingleTask);

      expect(result.prompt).toContain('Testing Guidelines');
      expect(result.prompt).toContain('Prefer testing real behavior over mocking');
      expect(result.prompt).toContain('Tests MUST test actual code');
      expect(result.prompt).toContain('Key Testing Areas to Cover');
    });

    test('includes guidance for both single and multiple task scenarios', () => {
      const singleResult = getTesterPrompt(sampleSingleTask);
      const multiResult = getTesterPrompt(sampleMultipleTasks);

      // Both should mention handling single or multiple tasks
      expect(singleResult.prompt).toContain(
        'You may receive a single task or multiple related tasks'
      );
      expect(multiResult.prompt).toContain(
        'You may receive a single task or multiple related tasks'
      );

      // Both should have the same core testing philosophy
      expect(singleResult.prompt).toContain('Test Philosophy');
      expect(multiResult.prompt).toContain('Test Philosophy');
    });
  });

  describe('getReviewerPrompt', () => {
    test('returns correct AgentDefinition structure for single task', () => {
      const result = getReviewerPrompt(sampleSingleTask);

      expect(result).toMatchObject({
        name: 'reviewer',
        description:
          'Reviews implementation and tests for quality, security, and adherence to project standards',
        prompt: expect.any(String),
      });
    });

    test('returns correct AgentDefinition structure for multiple tasks', () => {
      const result = getReviewerPrompt(sampleMultipleTasks);

      expect(result).toMatchObject({
        name: 'reviewer',
        description:
          'Reviews implementation and tests for quality, security, and adherence to project standards',
        prompt: expect.any(String),
      });
    });

    test('includes context content in prompt', () => {
      const result = getReviewerPrompt(sampleSingleTask);

      expect(result.prompt).toContain(sampleSingleTask);
    });

    test('contains batch-review instructions for multiple tasks', () => {
      const result = getReviewerPrompt(sampleMultipleTasks);

      // Check for key batch-review instructions
      expect(result.prompt).toContain('Reviewing Multiple Tasks');
      expect(result.prompt).toContain('Scrutinize interactions between tasks');
      expect(result.prompt).toContain('Code duplication across tasks that should be consolidated');
      expect(result.prompt).toContain('Inconsistent patterns or approaches between related implementations');
      expect(result.prompt).toContain('Missing integration tests for task interactions');
      expect(result.prompt).toContain('Performance bottlenecks introduced by task combinations');
    });

    test('maintains core review guidelines', () => {
      const result = getReviewerPrompt(sampleSingleTask);

      expect(result.prompt).toContain('Critical Issues to Flag');
      expect(result.prompt).toContain('Code Correctness (HIGH PRIORITY)');
      expect(result.prompt).toContain('Security Vulnerabilities (HIGH PRIORITY)');
      expect(result.prompt).toContain('Project Violations (MEDIUM PRIORITY)');
      expect(result.prompt).toContain('Testing Problems (HIGH PRIORITY)');
    });

    test('includes guidance for both single and multiple task scenarios', () => {
      const singleResult = getReviewerPrompt(sampleSingleTask);
      const multiResult = getReviewerPrompt(sampleMultipleTasks);

      // Both should have the reviewing multiple tasks section
      expect(singleResult.prompt).toContain('Reviewing Multiple Tasks');
      expect(multiResult.prompt).toContain('Reviewing Multiple Tasks');

      // Both should have the same core review responsibilities
      expect(singleResult.prompt).toContain('Your Primary Responsibilities');
      expect(multiResult.prompt).toContain('Your Primary Responsibilities');
    });

    test('includes proper reviewer tone and approach', () => {
      const result = getReviewerPrompt(sampleSingleTask);

      expect(result.prompt).toContain('Do not be polite or encouraging');
      expect(result.prompt).toContain('Your job is to find issues, not to praise good code');
      expect(result.prompt).toContain('Use git commands to see the recent related commits');
    });
  });

  describe('All prompt functions', () => {
    test('maintain consistent structure across all agents', () => {
      const implementer = getImplementerPrompt(sampleSingleTask);
      const tester = getTesterPrompt(sampleSingleTask);
      const reviewer = getReviewerPrompt(sampleSingleTask);

      // All should have required fields
      [implementer, tester, reviewer].forEach((agent) => {
        expect(agent).toHaveProperty('name');
        expect(agent).toHaveProperty('description');
        expect(agent).toHaveProperty('prompt');
        expect(typeof agent.name).toBe('string');
        expect(typeof agent.description).toBe('string');
        expect(typeof agent.prompt).toBe('string');
        expect(agent.prompt.length).toBeGreaterThan(0);
      });
    });

    test('properly interpolate context content', () => {
      const testContext =
        '## Test Context\nThis is a unique test context string that should appear in prompts.';

      const implementer = getImplementerPrompt(testContext);
      const tester = getTesterPrompt(testContext);
      const reviewer = getReviewerPrompt(testContext);

      expect(implementer.prompt).toContain(testContext);
      expect(tester.prompt).toContain(testContext);
      expect(reviewer.prompt).toContain(testContext);
    });

    test('handle empty context gracefully', () => {
      const emptyContext = '';

      const implementer = getImplementerPrompt(emptyContext);
      const tester = getTesterPrompt(emptyContext);
      const reviewer = getReviewerPrompt(emptyContext);

      // Should still return valid AgentDefinition objects
      expect(implementer.name).toBe('implementer');
      expect(tester.name).toBe('tester');
      expect(reviewer.name).toBe('reviewer');

      // Prompts should still have content even with empty context
      expect(implementer.prompt.length).toBeGreaterThan(100);
      expect(tester.prompt.length).toBeGreaterThan(100);
      expect(reviewer.prompt.length).toBeGreaterThan(100);
    });
  });

  describe('Custom instructions functionality', () => {
    const customInstructions = `## Custom Project Guidelines
- Always use TypeScript strict mode
- Prefer functional programming patterns
- Include JSDoc comments for all public functions`;

    test('getImplementerPrompt includes custom instructions when provided', () => {
      const result = getImplementerPrompt(sampleSingleTask, customInstructions);

      expect(result.prompt).toContain('## Custom Instructions');
      expect(result.prompt).toContain(customInstructions);
      expect(result.prompt).toContain(sampleSingleTask);
    });

    test('getTesterPrompt includes custom instructions when provided', () => {
      const result = getTesterPrompt(sampleSingleTask, customInstructions);

      expect(result.prompt).toContain('## Custom Instructions');
      expect(result.prompt).toContain(customInstructions);
      expect(result.prompt).toContain(sampleSingleTask);
    });

    test('getReviewerPrompt includes custom instructions when provided', () => {
      const result = getReviewerPrompt(sampleSingleTask, customInstructions);

      expect(result.prompt).toContain('## Custom Instructions');
      expect(result.prompt).toContain(customInstructions);
      expect(result.prompt).toContain(sampleSingleTask);
    });

    test('custom instructions appear after context but before primary responsibilities', () => {
      const result = getImplementerPrompt(sampleSingleTask, customInstructions);
      const prompt = result.prompt;

      const contextIndex = prompt.indexOf('## Context and Task');
      const customIndex = prompt.indexOf('## Custom Instructions');
      const responsibilitiesIndex = prompt.indexOf('## Your Primary Responsibilities');

      expect(contextIndex).toBeGreaterThan(-1);
      expect(customIndex).toBeGreaterThan(-1);
      expect(responsibilitiesIndex).toBeGreaterThan(-1);
      expect(customIndex).toBeGreaterThan(contextIndex);
      expect(responsibilitiesIndex).toBeGreaterThan(customIndex);
    });

    test('prompts work correctly without custom instructions (backward compatibility)', () => {
      const implementer = getImplementerPrompt(sampleSingleTask);
      const tester = getTesterPrompt(sampleSingleTask);
      const reviewer = getReviewerPrompt(sampleSingleTask);

      // Should not contain custom instructions section
      expect(implementer.prompt).not.toContain('## Custom Instructions');
      expect(tester.prompt).not.toContain('## Custom Instructions');
      expect(reviewer.prompt).not.toContain('## Custom Instructions');

      // Should still have all core content
      expect(implementer.prompt).toContain('## Context and Task');
      expect(implementer.prompt).toContain('## Your Primary Responsibilities');
      expect(tester.prompt).toContain('## Context and Task');
      expect(tester.prompt).toContain('## Your Primary Responsibilities');
      expect(reviewer.prompt).toContain('## Context and Task');
      expect(reviewer.prompt).toContain('## Your Primary Responsibilities');
    });

    test('empty custom instructions do not add section', () => {
      const result = getImplementerPrompt(sampleSingleTask, '');

      expect(result.prompt).not.toContain('## Custom Instructions');
      expect(result.prompt).toContain('## Context and Task');
      expect(result.prompt).toContain('## Your Primary Responsibilities');
    });

    test('undefined custom instructions do not add section', () => {
      const result = getImplementerPrompt(sampleSingleTask, undefined);

      expect(result.prompt).not.toContain('## Custom Instructions');
      expect(result.prompt).toContain('## Context and Task');
      expect(result.prompt).toContain('## Your Primary Responsibilities');
    });

    test('custom instructions preserve formatting', () => {
      const formattedInstructions = `## Custom Guidelines

### Coding Standards
- Use ESLint rules
- Write unit tests

### Documentation
- Include README updates
- Add inline comments`;

      const result = getImplementerPrompt(sampleSingleTask, formattedInstructions);

      expect(result.prompt).toContain(formattedInstructions);
      expect(result.prompt).toContain('### Coding Standards');
      expect(result.prompt).toContain('### Documentation');
    });
  });

  describe('Batch-specific functionality verification', () => {
    test('implementer prompt includes all key batch instructions', () => {
      const result = getImplementerPrompt(sampleMultipleTasks);
      const prompt = result.prompt;

      // Verify specific batch instructions are present
      const expectedInstructions = [
        'Work on them efficiently by considering shared code',
        'Look for opportunities to implement common functionality once',
        'Avoid duplicating similar logic',
        'Consider the interdependencies between tasks',
        'implement in a logical order',
        'Group related changes together',
        'Ensure that all tasks work together harmoniously',
        'Test the complete batch of functionality',
      ];

      expectedInstructions.forEach((instruction) => {
        expect(prompt).toContain(instruction);
      });
    });

    test('tester prompt includes all key batch instructions', () => {
      const result = getTesterPrompt(sampleMultipleTasks);
      const prompt = result.prompt;

      const expectedInstructions = [
        'Create comprehensive tests that cover all functionality from all provided tasks',
        'Look for integration points between different tasks',
        'Avoid duplicating similar test setups',
        'Test the complete workflow across all implemented tasks',
        'Ensure test coverage spans the entire batch',
        'Create tests that verify tasks work together correctly',
        'Consider edge cases that might arise from the interaction',
      ];

      expectedInstructions.forEach((instruction) => {
        expect(prompt).toContain(instruction);
      });
    });

    test('reviewer prompt includes all key batch instructions', () => {
      const result = getReviewerPrompt(sampleMultipleTasks);
      const prompt = result.prompt;

      const expectedInstructions = [
        'Scrutinize interactions between tasks for conflicts',
        'Code duplication across tasks that should be consolidated',
        'Inconsistent patterns or approaches between related implementations',
        'Missing integration tests for task interactions',
        'Performance bottlenecks introduced by task combinations',
      ];

      expectedInstructions.forEach((instruction) => {
        expect(prompt).toContain(instruction);
      });
    });
  });
});
