// Command handler for 'rmplan agent' and 'rmplan run'
// Automatically executes steps in a plan YAML file

import { rmplanAgent } from '../agent.js';

export async function handleAgentCommand(
  planFile: string | undefined,
  options: any,
  globalCliOptions: any
) {
  await rmplanAgent(planFile, options, globalCliOptions);
}
