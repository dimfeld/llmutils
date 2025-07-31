import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'glob';
import { getGitRoot } from '../../../common/git.ts';
import { error } from '../../../logging.ts';

export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
}

export async function generateAgentFiles(planId: string, agents: AgentDefinition[]): Promise<void> {
  const gitRoot = await getGitRoot();
  const agentsDir = path.join(gitRoot, '.claude', 'agents');

  // Create .claude/agents directory if it doesn't exist
  await fs.mkdir(agentsDir, { recursive: true });

  // Generate each agent file
  for (const agent of agents) {
    const fileName = `rmplan-${planId}-${agent.name}.md`;
    const filePath = path.join(agentsDir, fileName);

    const content = `---
name: rmplan-${planId}-${agent.name}
description: ${agent.description}
---

${agent.prompt}
`;

    await fs.writeFile(filePath, content, 'utf-8');
  }
}

export async function removeAgentFiles(planId: string): Promise<void> {
  const gitRoot = await getGitRoot();
  const agentsDir = path.join(gitRoot, '.claude', 'agents');

  try {
    // Find all files matching the pattern
    const pattern = path.join(agentsDir, `rmplan-${planId}-*.md`);
    const files = await glob(pattern);

    // Remove each matching file
    for (const file of files) {
      try {
        await fs.unlink(file);
      } catch (err) {
        // Ignore errors if file doesn't exist
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          error(`Failed to remove agent file ${file}:`, err);
        }
      }
    }
  } catch (err) {
    // If agents directory doesn't exist, that's fine
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      error('Failed to remove agent files:', err);
    }
  }
}
