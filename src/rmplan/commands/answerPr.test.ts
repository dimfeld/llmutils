import { describe, test, expect, beforeEach } from 'bun:test';
import { handleAnswerPrCommand } from './answerPr.js';
import type { Command } from 'commander';
import { mock } from 'bun:test';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('answerPr command', () => {
  let mockHandleRmprCommand: any;
  let mockCommand: Command;
  let mockConfig: any;

  beforeEach(async () => {
    await moduleMocker.clear();

    // Mock dependencies
    mockHandleRmprCommand = mock();
    await moduleMocker.mock('../../rmpr/main.js', () => ({
      handleRmprCommand: mockHandleRmprCommand,
    }));

    // Mock command structure
    mockCommand = {
      parent: {
        opts: () => ({ debug: false }),
      },
    } as any;

    // Mock config
    mockConfig = {
      defaultExecutor: 'copy-paste',
      answerPr: {
        mode: 'hybrid',
        comment: true,
        commit: true,
      },
    };

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(() => Promise.resolve(mockConfig)),
    }));
  });

  test('should apply config defaults when options not specified', async () => {
    const options = {};

    await handleAnswerPrCommand('PR-123', options, mockCommand);

    expect(mockHandleRmprCommand).toHaveBeenCalledWith(
      'PR-123',
      {
        executor: 'copy-paste',
        mode: 'hybrid',
        comment: true,
        commit: true,
      },
      { debug: false },
      mockConfig
    );
  });

  test('should not override CLI options with config defaults', async () => {
    const options = {
      executor: 'claude-code',
      mode: 'inline',
      comment: false,
      commit: false,
    };

    await handleAnswerPrCommand('PR-123', options, mockCommand);

    expect(mockHandleRmprCommand).toHaveBeenCalledWith(
      'PR-123',
      {
        executor: 'claude-code',
        mode: 'inline',
        comment: false,
        commit: false,
      },
      { debug: false },
      mockConfig
    );
  });

  test('should apply config defaults only for undefined options', async () => {
    const options = {
      mode: 'separate',
      // comment and commit not specified, should use config defaults
    };

    await handleAnswerPrCommand('PR-123', options, mockCommand);

    expect(mockHandleRmprCommand).toHaveBeenCalledWith(
      'PR-123',
      {
        executor: 'copy-paste',
        mode: 'separate',
        comment: true,
        commit: true,
      },
      { debug: false },
      mockConfig
    );
  });

  test('should handle missing config gracefully', async () => {
    // Update mock to return empty config
    await moduleMocker.clear();
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(() => Promise.resolve({})),
    }));
    await moduleMocker.mock('../../rmpr/main.js', () => ({
      handleRmprCommand: mockHandleRmprCommand,
    }));

    const options = {};

    await handleAnswerPrCommand('PR-123', options, mockCommand);

    expect(mockHandleRmprCommand).toHaveBeenCalledWith(
      'PR-123',
      {
        executor: 'copy-only', // DEFAULT_EXECUTOR
        mode: 'hybrid', // Default mode from the code
      },
      { debug: false },
      {}
    );
  });
});
