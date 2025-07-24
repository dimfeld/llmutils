import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ModuleMocker } from '../testing.js';
import { invokeClaudeCodeForGeneration } from './claude_utils.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('invokeClaudeCodeForGeneration', () => {
  // Mock functions
  const logSpy = mock(() => {});
  const runClaudeCodeGenerationSpy = mock(async () => 'Generated content from Claude');

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    runClaudeCodeGenerationSpy.mockClear();

    // Mock modules
    await moduleMocker.mock('../logging.js', () => ({
      log: logSpy,
    }));

    await moduleMocker.mock('./executors/claude_code_orchestrator.js', () => ({
      runClaudeCodeGeneration: runClaudeCodeGenerationSpy,
    }));
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('calls runClaudeCodeGeneration with correct arguments', async () => {
    const planningPrompt = 'Test planning prompt';
    const generationPrompt = 'Test generation prompt';
    const options = {
      model: 'test-model',
      includeDefaultTools: true,
    };

    const result = await invokeClaudeCodeForGeneration(planningPrompt, generationPrompt, options);

    // Verify log was called
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Using Claude Code for two-step planning and generation')
    );

    // Verify runClaudeCodeGeneration was called with correct arguments
    expect(runClaudeCodeGenerationSpy).toHaveBeenCalledTimes(1);
    expect(runClaudeCodeGenerationSpy).toHaveBeenCalledWith({
      planningPrompt,
      generationPrompt,
      options: {
        includeDefaultTools: true,
      },
      model: 'test-model',
    });

    // Verify the result
    expect(result).toBe('Generated content from Claude');
  });

  test('defaults includeDefaultTools to true when not provided', async () => {
    const planningPrompt = 'Planning prompt';
    const generationPrompt = 'Generation prompt';
    const options = {
      model: 'custom-model',
    };

    await invokeClaudeCodeForGeneration(planningPrompt, generationPrompt, options);

    expect(runClaudeCodeGenerationSpy).toHaveBeenCalledWith({
      planningPrompt,
      generationPrompt,
      options: {
        includeDefaultTools: true,
      },
      model: 'custom-model',
    });
  });

  test('handles undefined model option', async () => {
    const planningPrompt = 'Planning prompt';
    const generationPrompt = 'Generation prompt';
    const options = {};

    await invokeClaudeCodeForGeneration(planningPrompt, generationPrompt, options);

    expect(runClaudeCodeGenerationSpy).toHaveBeenCalledWith({
      planningPrompt,
      generationPrompt,
      options: {
        includeDefaultTools: true,
      },
      model: undefined,
    });
  });
});
