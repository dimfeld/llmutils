import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { buildAgentsArgument, type AgentDefinition } from './agent_generator.ts';
import { ModuleMocker } from '../../../testing.ts';

describe('agent_generator', () => {
  let tempDir: string;
  let agentsDir: string;
  const moduleMocker = new ModuleMocker(import.meta);

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = await mkdtemp(path.join(tmpdir(), 'agent-generator-test-'));
    agentsDir = path.join(tempDir, '.claude', 'agents');

    // Mock getGitRoot to return our temp directory
    await moduleMocker.mock('../../../common/git.ts', () => ({
      getGitRoot: async () => tempDir,
    }));
  });

  afterEach(async () => {
    // Clean up
    moduleMocker.clear();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('buildAgentsArgument', () => {
    test('builds JSON argument for single agent', () => {
      const agents: AgentDefinition[] = [
        {
          name: 'implementer',
          description: 'Implements new features',
          prompt: 'You are an implementation agent.',
        },
      ];

      const result = buildAgentsArgument(agents);
      const parsed = JSON.parse(result);

      expect(parsed).toEqual({
        'tim-implementer': {
          description: 'Implements new features',
          prompt: 'You are an implementation agent.',
        },
      });
    });

    test('builds JSON argument for multiple agents', () => {
      const agents: AgentDefinition[] = [
        {
          name: 'implementer',
          description: 'Implements new features',
          prompt: 'You are an implementation agent.',
        },
        {
          name: 'tester',
          description: 'Tests the implementation',
          prompt: 'You are a testing agent.',
        },
        {
          name: 'reviewer',
          description: 'Reviews code',
          prompt: 'You are a review agent.',
        },
      ];

      const result = buildAgentsArgument(agents);
      const parsed = JSON.parse(result);

      expect(parsed).toEqual({
        'tim-implementer': {
          description: 'Implements new features',
          prompt: 'You are an implementation agent.',
        },
        'tim-tester': {
          description: 'Tests the implementation',
          prompt: 'You are a testing agent.',
        },
        'tim-reviewer': {
          description: 'Reviews code',
          prompt: 'You are a review agent.',
        },
      });
    });

    test('includes model when provided', () => {
      const agents: AgentDefinition[] = [
        {
          name: 'implementer',
          description: 'Implements new features',
          prompt: 'You are an implementation agent.',
          model: 'sonnet',
        },
      ];

      const result = buildAgentsArgument(agents);
      const parsed = JSON.parse(result);

      expect(parsed).toEqual({
        'tim-implementer': {
          description: 'Implements new features',
          prompt: 'You are an implementation agent.',
          model: 'sonnet',
        },
      });
    });

    test('includes tools when provided', () => {
      const agents: AgentDefinition[] = [
        {
          name: 'implementer',
          description: 'Implements new features',
          prompt: 'You are an implementation agent.',
          tools: ['Read', 'Write', 'Edit'],
        },
      ];

      const result = buildAgentsArgument(agents);
      const parsed = JSON.parse(result);

      expect(parsed).toEqual({
        'tim-implementer': {
          description: 'Implements new features',
          prompt: 'You are an implementation agent.',
          tools: ['Read', 'Write', 'Edit'],
        },
      });
    });

    test('includes both model and tools when provided', () => {
      const agents: AgentDefinition[] = [
        {
          name: 'reviewer',
          description: 'Reviews code',
          prompt: 'You are a review agent.',
          model: 'opus',
          tools: ['Read', 'Grep', 'Glob'],
        },
      ];

      const result = buildAgentsArgument(agents);
      const parsed = JSON.parse(result);

      expect(parsed).toEqual({
        'tim-reviewer': {
          description: 'Reviews code',
          prompt: 'You are a review agent.',
          model: 'opus',
          tools: ['Read', 'Grep', 'Glob'],
        },
      });
    });

    test('omits tools when empty array', () => {
      const agents: AgentDefinition[] = [
        {
          name: 'implementer',
          description: 'Implements new features',
          prompt: 'You are an implementation agent.',
          tools: [],
        },
      ];

      const result = buildAgentsArgument(agents);
      const parsed = JSON.parse(result);

      expect(parsed).toEqual({
        'tim-implementer': {
          description: 'Implements new features',
          prompt: 'You are an implementation agent.',
        },
      });
      expect(parsed['tim-implementer'].tools).toBeUndefined();
    });

    test('handles empty agents array', () => {
      const agents: AgentDefinition[] = [];

      const result = buildAgentsArgument(agents);
      const parsed = JSON.parse(result);

      expect(parsed).toEqual({});
    });

    test('handles multi-line prompts', () => {
      const agents: AgentDefinition[] = [
        {
          name: 'implementer',
          description: 'Implements features',
          prompt: `Line 1
Line 2
Line 3`,
        },
      ];

      const result = buildAgentsArgument(agents);
      const parsed = JSON.parse(result);

      expect(parsed['tim-implementer'].prompt).toBe('Line 1\nLine 2\nLine 3');
    });

    test('handles special characters in prompts', () => {
      const agents: AgentDefinition[] = [
        {
          name: 'implementer',
          description: 'Implements features',
          prompt: 'Test "quotes" and \'apostrophes\' and \\ backslashes',
        },
      ];

      const result = buildAgentsArgument(agents);
      const parsed = JSON.parse(result);

      expect(parsed['tim-implementer'].prompt).toBe(
        'Test "quotes" and \'apostrophes\' and \\ backslashes'
      );
    });
  });
});
