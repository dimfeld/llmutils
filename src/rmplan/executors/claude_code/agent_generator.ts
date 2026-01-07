export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  tools?: string[];
  skills?: string[];
}

/**
 * Builds the --agents JSON argument for Claude Code from agent definitions.
 * This converts our AgentDefinition format to the format expected by Claude Code's --agents argument.
 */
export function buildAgentsArgument(agents: AgentDefinition[]): string {
  const agentsObj: Record<string, any> = {};

  for (const agent of agents) {
    const name = `rmplan-${agent.name}`;
    agentsObj[name] = {
      description: agent.description,
      prompt: agent.prompt,
    };

    if (agent.model) {
      agentsObj[name].model = agent.model;
    }

    if (agent.tools && agent.tools.length > 0) {
      agentsObj[name].tools = agent.tools;
    }

    if (agent.skills && agent.skills.length > 0) {
      agentsObj[name].skills = agent.skills;
    }
  }

  return JSON.stringify(agentsObj);
}
