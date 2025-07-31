import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { generateAgentFiles, removeAgentFiles, type AgentDefinition } from './agent_generator.ts';
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

  describe('generateAgentFiles', () => {
    test('creates agents directory if it does not exist', async () => {
      const agents: AgentDefinition[] = [
        {
          name: 'implementer',
          description: 'Implements new features',
          prompt: 'You are an implementation agent.',
        },
      ];

      await generateAgentFiles('test-plan-123', agents);

      // Check that directory was created
      const stats = await fs.stat(agentsDir);
      expect(stats.isDirectory()).toBe(true);
    });

    test('creates agent files with correct format', async () => {
      const agents: AgentDefinition[] = [
        {
          name: 'implementer',
          description: 'Implements new features',
          prompt: 'You are an implementation agent that writes code.',
        },
        {
          name: 'tester',
          description: 'Tests the implementation',
          prompt: 'You are a testing agent that writes tests.',
        },
        {
          name: 'reviewer',
          description: 'Reviews the code',
          prompt: 'You are a code review agent.',
        },
      ];

      await generateAgentFiles('test-plan-456', agents);

      // Check each file
      for (const agent of agents) {
        const fileName = `rmplan-test-plan-456-${agent.name}.md`;
        const filePath = path.join(agentsDir, fileName);

        const content = await fs.readFile(filePath, 'utf-8');

        // Check YAML frontmatter
        expect(content).toContain('---');
        expect(content).toContain(`name: rmplan-test-plan-456-${agent.name}`);
        expect(content).toContain(`description: ${agent.description}`);
        expect(content).toContain('---');

        // Check prompt content
        expect(content).toContain(agent.prompt);

        // Verify exact format
        const expectedContent = `---
name: rmplan-test-plan-456-${agent.name}
description: ${agent.description}
---

${agent.prompt}
`;
        expect(content).toBe(expectedContent);
      }
    });

    test('overwrites existing agent files', async () => {
      const agent: AgentDefinition = {
        name: 'implementer',
        description: 'Original description',
        prompt: 'Original prompt',
      };

      // Create initial file
      await generateAgentFiles('test-plan-789', [agent]);

      // Update agent definition
      agent.description = 'Updated description';
      agent.prompt = 'Updated prompt';

      // Generate again
      await generateAgentFiles('test-plan-789', [agent]);

      // Check that file was updated
      const filePath = path.join(agentsDir, 'rmplan-test-plan-789-implementer.md');
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toContain('Updated description');
      expect(content).toContain('Updated prompt');
      expect(content).not.toContain('Original');
    });
  });

  describe('removeAgentFiles', () => {
    test('removes all agent files for a given plan ID', async () => {
      // Create some agent files
      const agents: AgentDefinition[] = [
        { name: 'implementer', description: 'Impl', prompt: 'Impl prompt' },
        { name: 'tester', description: 'Test', prompt: 'Test prompt' },
        { name: 'reviewer', description: 'Review', prompt: 'Review prompt' },
      ];

      await generateAgentFiles('remove-test-123', agents);

      // Also create a file for a different plan to ensure it's not removed
      await generateAgentFiles('other-plan-456', [
        { name: 'keeper', description: 'Keep me', prompt: 'Should not be removed' },
      ]);

      // Remove files for the first plan
      await removeAgentFiles('remove-test-123');

      // Check that correct files were removed
      const remainingFiles = await fs.readdir(agentsDir);
      expect(remainingFiles).toHaveLength(1);
      expect(remainingFiles[0]).toBe('rmplan-other-plan-456-keeper.md');
    });

    test('handles non-existent files gracefully', async () => {
      // Try to remove files that don't exist
      // Should not throw any errors
      await removeAgentFiles('non-existent-plan');
    });

    test('handles non-existent agents directory gracefully', async () => {
      // Remove the entire .claude directory
      await rm(path.join(tempDir, '.claude'), { recursive: true, force: true });

      // Should not throw
      await removeAgentFiles('any-plan');
    });

    test('removes files with special characters in plan ID', async () => {
      // Create agent with special characters in plan ID
      const agents: AgentDefinition[] = [
        { name: 'implementer', description: 'Impl', prompt: 'Impl prompt' },
      ];

      const specialPlanId = 'test-plan_123-abc';
      await generateAgentFiles(specialPlanId, agents);

      // Verify file was created
      const filePath = path.join(agentsDir, `rmplan-${specialPlanId}-implementer.md`);
      await expect(fs.stat(filePath)).resolves.toBeTruthy();

      // Remove the file
      await removeAgentFiles(specialPlanId);

      // Verify file was removed
      await expect(fs.stat(filePath)).rejects.toThrow();
    });
  });

  describe('edge cases', () => {
    test('handles empty agents array', async () => {
      // Should not throw when given empty array
      await generateAgentFiles('empty-plan', []);

      // Directory should still be created
      const stats = await fs.stat(agentsDir);
      expect(stats.isDirectory()).toBe(true);
    });

    test('handles agent names with spaces', async () => {
      const agent: AgentDefinition = {
        name: 'code reviewer',
        description: 'Reviews code with spaces',
        prompt: 'I review code',
      };

      await generateAgentFiles('space-plan', [agent]);

      const fileName = 'rmplan-space-plan-code reviewer.md';
      const filePath = path.join(agentsDir, fileName);

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('name: rmplan-space-plan-code reviewer');
    });

    test('handles multi-line prompts', async () => {
      const agent: AgentDefinition = {
        name: 'multi',
        description: 'Multi-line prompt test',
        prompt: `This is a multi-line prompt.

It has several paragraphs.

And even some code:
\`\`\`typescript
function example() {
  return 42;
}
\`\`\``,
      };

      await generateAgentFiles('multi-plan', [agent]);

      const filePath = path.join(agentsDir, 'rmplan-multi-plan-multi.md');
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toContain('This is a multi-line prompt.');
      expect(content).toContain('function example()');
    });
  });
});
