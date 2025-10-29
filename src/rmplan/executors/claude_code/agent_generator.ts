export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  tools?: string[];
}

/**
 * Builds the --agents JSON argument for Claude Code from agent definitions.
 * This converts our AgentDefinition format to the format expected by Claude Code's --agents argument.
 */
export function buildAgentsArgument(agents: AgentDefinition[]): string {
  const agentsObj: Record<string, any> = {};

  for (const agent of agents) {
    agentsObj[agent.name] = {
      description: agent.description,
      prompt: agent.prompt,
    };

    if (agent.model) {
      agentsObj[agent.name].model = agent.model;
    }

    if (agent.tools && agent.tools.length > 0) {
      agentsObj[agent.name].tools = agent.tools;
    }
  }

  return JSON.stringify(agentsObj);
}
