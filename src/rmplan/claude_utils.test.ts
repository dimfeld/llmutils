import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ModuleMocker } from '../testing.js';
import { invokeClaudeCodeForGeneration } from './claude_utils.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('invokeClaudeCodeForGeneration', () => {
  // Mock functions
  const logSpy = mock(() => {});
  const runClaudeCodeGenerationSpy = mock(async () => ({
    generationOutput: 'Generated content from Claude',
    researchOutput: 'Research summary',
  }));

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
      expect.stringContaining('Using Claude Code for multi-step planning and generation')
    );

    // Verify runClaudeCodeGeneration was called with correct arguments
    expect(runClaudeCodeGenerationSpy).toHaveBeenCalledTimes(1);
    expect(runClaudeCodeGenerationSpy).toHaveBeenCalledWith({
      planningPrompt,
      generationPrompt,
      researchPrompt: undefined,
      options: {
        includeDefaultTools: true,
      },
      model: 'test-model',
    });

    // Verify the result
    expect(result).toEqual({
      generationOutput: 'Generated content from Claude',
      researchOutput: 'Research summary',
    });
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
      researchPrompt: undefined,
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
      researchPrompt: undefined,
      options: {
        includeDefaultTools: true,
      },
      model: undefined,
    });
  });

  test('passes through research prompt when provided', async () => {
    const planningPrompt = 'Planning prompt';
    const generationPrompt = 'Generation prompt';
    const researchPrompt = 'Research prompt';

    await invokeClaudeCodeForGeneration(planningPrompt, generationPrompt, {
      model: 'custom-model',
      researchPrompt,
      includeDefaultTools: false,
    });

    expect(runClaudeCodeGenerationSpy).toHaveBeenCalledWith({
      planningPrompt,
      generationPrompt,
      researchPrompt,
      options: {
        includeDefaultTools: false,
      },
      model: 'custom-model',
    });
  });
});
