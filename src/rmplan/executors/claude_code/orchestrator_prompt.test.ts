import { test, describe, expect } from 'bun:test';
import { wrapWithOrchestration } from './orchestrator_prompt.ts';

describe('wrapWithOrchestration', () => {
  const testContextContent = 'This is test context content for the task.';
  const testPlanId = 'test-plan-123';
  const testPlanFilePath = '/path/to/plan.yml';

  describe('backward compatibility', () => {
    test('works with legacy two-parameter signature', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId);

      expect(result).toBeString();
      expect(result).toContain('Multi-Agent Orchestration Instructions');
      expect(result).toContain(`rmplan-${testPlanId}-implementer`);
      expect(result).toContain(`rmplan-${testPlanId}-tester`);
      expect(result).toContain(`rmplan-${testPlanId}-reviewer`);
      expect(result).toContain(testContextContent);

      // Should not contain batch mode instructions
      expect(result).not.toContain('BATCH TASK PROCESSING MODE');
      expect(result).not.toContain('Task Selection Phase');
      expect(result).not.toContain('Plan Update Phase');
    });

    test('works with options parameter as undefined', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, undefined);

      expect(result).toBeString();
      expect(result).toContain('Multi-Agent Orchestration Instructions');
      expect(result).not.toContain('BATCH TASK PROCESSING MODE');
    });

    test('works with empty options object', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {});

      expect(result).toBeString();
      expect(result).toContain('Multi-Agent Orchestration Instructions');
      expect(result).not.toContain('BATCH TASK PROCESSING MODE');
    });
  });

  describe('normal mode (non-batch)', () => {
    test('generates standard orchestration instructions when batchMode is false', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {
        batchMode: false,
        planFilePath: testPlanFilePath,
      });

      expect(result).toContain('Multi-Agent Orchestration Instructions');
      expect(result).toContain(
        'coordinate between specialized agents to complete the coding task described below'
      );
      expect(result).not.toContain('BATCH TASK PROCESSING MODE');
      expect(result).not.toContain('Task Selection Phase');
      expect(result).not.toContain('Plan Update Phase');

      // Should contain standard workflow steps
      expect(result).toContain('Implementation Phase');
      expect(result).toContain('Testing Phase');
      expect(result).toContain('Review Phase');
      expect(result).toContain('Iteration');

      // Should not include plan file path in instructions
      expect(result).not.toContain(testPlanFilePath);
    });

    test('generates standard orchestration instructions when batchMode is not provided', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {
        planFilePath: testPlanFilePath,
      });

      expect(result).toContain('Multi-Agent Orchestration Instructions');
      expect(result).not.toContain('BATCH TASK PROCESSING MODE');
      expect(result).toContain('Implementation Phase');
      expect(result).not.toContain('Task Selection Phase');
    });
  });

  describe('batch mode', () => {
    test('generates batch mode instructions when batchMode is true', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {
        batchMode: true,
        planFilePath: testPlanFilePath,
      });

      expect(result).toContain('BATCH TASK PROCESSING MODE');
      expect(result).toContain(
        'coordinate between specialized agents to complete the coding tasks described below'
      );

      // Should contain batch-specific workflow instructions
      expect(result).toContain('Task Selection Phase (Batch Mode Only)');
      expect(result).toContain('Plan Update Phase (Batch Mode Only)');
      expect(result).toContain('analyze all provided tasks and select a logical subset to work on');

      // Should contain task selection guidelines
      expect(result).toContain('Task Selection Guidelines');
      expect(result).toContain('Related functionality');
      expect(result).toContain('Shared files');
      expect(result).toContain('Logical dependencies');
      expect(result).toContain('Efficiency');
      expect(result).toContain('Reasonable scope');
      expect(result).toContain('Select 2-5 related tasks rather than attempting all tasks at once');

      // Should contain plan file update instructions
      expect(result).toContain('Plan File Updates');
      expect(result).toContain('use the Edit tool to update the plan file');
      expect(result).toContain('setting `done: true`');
    });

    test('includes plan file path with @ prefix when provided', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {
        batchMode: true,
        planFilePath: testPlanFilePath,
      });

      expect(result).toContain(`@${testPlanFilePath}`);
      expect(result).toContain('use the Edit tool to update the plan file at: @/path/to/plan.yml');
    });

    test('handles missing planFilePath in batch mode', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {
        batchMode: true,
      });

      expect(result).toContain('BATCH TASK PROCESSING MODE');
      expect(result).toContain('PLAN_FILE_PATH_NOT_PROVIDED');
      expect(result).toContain(
        'use the Edit tool to update the plan file at: @PLAN_FILE_PATH_NOT_PROVIDED'
      );
    });

    test('contains YAML structure example in batch mode', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {
        batchMode: true,
        planFilePath: testPlanFilePath,
      });

      expect(result).toContain('```yaml');
      expect(result).toContain('tasks:');
      expect(result).toContain('id: "task-1"');
      expect(result).toContain('done: false  # Change this to true when completed');
      expect(result).toContain('done: true   # Already completed');
    });

    test('contains critical completion warnings in batch mode', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {
        batchMode: true,
        planFilePath: testPlanFilePath,
      });

      expect(result).toContain(
        '**CRITICAL**: Only mark tasks as `done: true` after they have been successfully implemented, tested, and reviewed'
      );
      expect(result).toContain('Do not mark tasks as done if:');
      expect(result).toContain('Implementation failed or is incomplete');
      expect(result).toContain('Tests are failing');
      expect(result).toContain('Code review identified blocking issues');
    });

    test('contains batch-specific workflow modifications', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {
        batchMode: true,
        planFilePath: testPlanFilePath,
      });

      // Check numbered workflow steps are adjusted for batch mode
      expect(result).toContain('1. **Task Selection Phase (Batch Mode Only)**');
      expect(result).toContain('2. **Implementation Phase**');
      expect(result).toContain('3. **Testing Phase**');
      expect(result).toContain('4. **Review Phase**');
      expect(result).toContain('5. **Plan Update Phase (Batch Mode Only)**');
      expect(result).toContain('6. **Iteration**');

      // Check step references in iteration section
      expect(result).toContain("Return to step 2 with the reviewer's feedback");
    });

    test('contains batch-specific important guidelines', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {
        batchMode: true,
        planFilePath: testPlanFilePath,
      });

      expect(result).toContain(
        '**In batch mode**: You must update the plan file to mark completed tasks as done before finishing'
      );
      expect(result).toContain(
        "**Be selective**: Don't attempt all tasks at once - choose a reasonable subset that works well together"
      );
    });
  });

  describe('plan file path handling', () => {
    test('includes plan file path when provided in normal mode', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {
        batchMode: false,
        planFilePath: testPlanFilePath,
      });

      // Plan file path should not be mentioned in normal mode instructions
      expect(result).not.toContain(testPlanFilePath);
      expect(result).not.toContain('@/path/to/plan.yml');
    });

    test('handles various plan file path formats', () => {
      const testPaths = [
        '/absolute/path/plan.yml',
        'relative/path/plan.yml',
        './plan.yml',
        '../parent/plan.yml',
        '/path/with spaces/plan.yml',
        '/path/with-special_chars@123/plan.yml',
      ];

      for (const testPath of testPaths) {
        const result = wrapWithOrchestration(testContextContent, testPlanId, {
          batchMode: true,
          planFilePath: testPath,
        });

        expect(result).toContain(`@${testPath}`);
      }
    });

    test('handles empty string plan file path', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {
        batchMode: true,
        planFilePath: '',
      });

      expect(result).toContain('@');
      expect(result).toContain('use the Edit tool to update the plan file at: @');
    });
  });

  describe('content structure verification', () => {
    test('preserves original context content in all modes', () => {
      const testContent = 'Specific task instructions with special characters: !@#$%^&*()';

      const normalResult = wrapWithOrchestration(testContent, testPlanId);
      const batchResult = wrapWithOrchestration(testContent, testPlanId, {
        batchMode: true,
        planFilePath: testPlanFilePath,
      });

      expect(normalResult).toContain(testContent);
      expect(batchResult).toContain(testContent);
    });

    test('contains all required agent references', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {
        batchMode: true,
        planFilePath: testPlanFilePath,
      });

      expect(result).toContain(`rmplan-${testPlanId}-implementer`);
      expect(result).toContain(`rmplan-${testPlanId}-tester`);
      expect(result).toContain(`rmplan-${testPlanId}-reviewer`);

      // Should contain usage instructions for each agent
      expect(result).toContain('Use this agent to implement new features and write code');
      expect(result).toContain('Use this agent to write and run tests for the implementation');
      expect(result).toContain('Use this agent to review code quality and suggest improvements');
    });

    test('contains essential orchestration guidelines', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {
        batchMode: true,
        planFilePath: testPlanFilePath,
      });

      expect(result).toContain('**DO NOT implement code directly**');
      expect(result).toContain('**DO NOT write tests directly**');
      expect(result).toContain('**DO NOT review code directly**');
      expect(result).toContain('You are responsible only for coordination');
      expect(result).toContain('delegate implementation tasks to the appropriate agents');
    });

    test('ends with original context content section', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {
        batchMode: true,
        planFilePath: testPlanFilePath,
      });

      expect(result).toContain('## Task Context');
      expect(result).toContain('Below is the original task that needs to be completed');
      expect(result).toContain('---');
      expect(result.endsWith(testContextContent)).toBe(true);
    });
  });

  describe('edge cases and robustness', () => {
    test('handles empty context content', () => {
      const result = wrapWithOrchestration('', testPlanId, {
        batchMode: true,
        planFilePath: testPlanFilePath,
      });

      expect(result).toBeString();
      expect(result).toContain('BATCH TASK PROCESSING MODE');
      expect(result).toEndWith('');
    });

    test('handles whitespace-only context content', () => {
      const whitespaceContent = '   \n\t\r\n   ';
      const result = wrapWithOrchestration(whitespaceContent, testPlanId, {
        batchMode: true,
        planFilePath: testPlanFilePath,
      });

      expect(result).toBeString();
      expect(result).toContain('BATCH TASK PROCESSING MODE');
      expect(result).toEndWith(whitespaceContent);
    });

    test('handles very long context content', () => {
      const longContent = 'A'.repeat(10000) + ' task description';
      const result = wrapWithOrchestration(longContent, testPlanId, {
        batchMode: true,
        planFilePath: testPlanFilePath,
      });

      expect(result).toBeString();
      expect(result).toContain('BATCH TASK PROCESSING MODE');
      expect(result).toContain(longContent);
      expect(result.length).toBeGreaterThan(longContent.length);
    });

    test('handles special characters in plan ID', () => {
      const specialPlanId = 'plan-123_test@domain.com';
      const result = wrapWithOrchestration(testContextContent, specialPlanId, {
        batchMode: true,
        planFilePath: testPlanFilePath,
      });

      expect(result).toContain(`rmplan-${specialPlanId}-implementer`);
      expect(result).toContain(`rmplan-${specialPlanId}-tester`);
      expect(result).toContain(`rmplan-${specialPlanId}-reviewer`);
    });

    test('handles unicode characters in context and paths', () => {
      const unicodeContent = 'Task with unicode: café, 文档, 🚀';
      const unicodePath = '/путь/к/файлу.yml';

      const result = wrapWithOrchestration(unicodeContent, testPlanId, {
        batchMode: true,
        planFilePath: unicodePath,
      });

      expect(result).toContain(unicodeContent);
      expect(result).toContain(`@${unicodePath}`);
    });
  });

  describe('boolean flag behavior', () => {
    test('enables batch mode for truthy values and disables for falsy values', () => {
      const falsyValues = [false, 0, '', null, undefined];
      const truthyValues = [true, 1, 'true', 'yes', [], {}];

      // Test falsy values - should not enable batch mode
      for (const value of falsyValues) {
        const result = wrapWithOrchestration(testContextContent, testPlanId, {
          batchMode: value as any,
          planFilePath: testPlanFilePath,
        });

        expect(result).not.toContain('BATCH TASK PROCESSING MODE');
        expect(result).not.toContain('Task Selection Phase');
      }

      // Test truthy values - should enable batch mode
      for (const value of truthyValues) {
        const result = wrapWithOrchestration(testContextContent, testPlanId, {
          batchMode: value as any,
          planFilePath: testPlanFilePath,
        });

        expect(result).toContain('BATCH TASK PROCESSING MODE');
        expect(result).toContain('Task Selection Phase');
      }
    });

    test('handles explicit boolean false correctly', () => {
      const result = wrapWithOrchestration(testContextContent, testPlanId, {
        batchMode: false,
        planFilePath: testPlanFilePath,
      });

      expect(result).not.toContain('BATCH TASK PROCESSING MODE');
      expect(result).toContain('Multi-Agent Orchestration Instructions');
    });
  });
});
