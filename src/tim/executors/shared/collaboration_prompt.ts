import {
  createOrchestrationDelegationRenderer,
  type OrchestratedAgentType,
} from './orchestration_delegation.js';
import type { OrchestrationOptions } from './orchestration_options.js';

/** Root-only tool and lifecycle contract for enabled collaborative sessions. */
export function buildCollaborativeToolGuidance(): string {
  return `## Collaborative Agent Tools

This root session has collaborative agent tools enabled. Use them for delegated implementation, testing, TDD test writing, and advisory review work.

- **StartAgent** starts a persistent subagent without waiting for it to finish. Its type is one of \`implementer\`, \`tester\`, \`tdd-tests\`, or \`reviewer\`; its executor is \`claude-code\` or \`codex-cli\`; and its initial message must state the task, file scope, constraints, and expected handoff.
- **ListAgents** returns the canonical names, types, executors, and visible lifecycle states for the orchestrator and active subagents. Use it when team state is unclear or before retrying a target.
- **SendAgentMessage** sends useful context, questions, blockers, decisions, and handoffs. The runtime supplies trusted source attribution; agents must use the canonical names returned by ListAgents when replying.
- **StopAgent** is available only to the orchestrator. Graceful stop is normal: request a final status and allow the manager to report terminal state. Use force only for an unresponsive agent or urgent shutdown.

Use short descriptive names when a stable address helps, or omit the name to accept a generated name. After StartAgent returns, always use its returned canonical name. The session allows at most eight nonterminal subagents; \`orchestrator\` is reserved for the root and does not count. Agents in \`starting\`, \`running-active\`, \`running-idle\`, \`finishing\`, and \`stopping\` states all hold capacity. Starting agents remain visible while preparing and must not be assumed ready for another assignment. Finishing and stopping agents remain visible but reject new assignments.

SendAgentMessage reports one of three successful delivery paths: \`steered\` for the active turn, \`queued\` when input waits in the recipient FIFO, or \`started-idle-turn\` when an idle provider begins a continuation. \`queued\` means accepted; do not resend it just because delivery was not immediate.

FinishAgent is self-only. The root cannot call it; ask each subagent to call FinishAgent after its assignment and final handoff are complete. Use the manager's terminal notification as the final handoff rather than relying on repeated ListAgents polling alone.

All agents share one working directory and see changes immediately. Before concurrent mutating work, assign disjoint file scopes or agree on one owner and an edit order for shared files. Read-only review and non-mutating inspection may overlap. Start only agents with a clear job; several agents of the same type are allowed when their scopes are safely separable.

A StartAgent reviewer is read-only and advisory. It may inspect evolving work, run non-mutating checks, and send findings, but it is not the formal quality gate. The authoritative review is the separate one-shot \`tim review\` command with fresh context and no collaborative tools.
`;
}

export function buildCollaborativeAvailableAgents(
  planId: string,
  agentTypes: readonly OrchestratedAgentType[],
  options: OrchestrationOptions
): string {
  const descriptions: Record<OrchestratedAgentType, string> = {
    implementer:
      'Change only the assigned implementation files and report the changes and verification.',
    tester:
      'Inspect or change only the assigned test and fixture files, run checks, and report failures and coverage gaps.',
    'tdd-tests':
      'Create the expected failing tests for the assigned scope and report the failure evidence before implementation starts.',
    reviewer:
      'Read-only inspect the evolving work, run non-mutating checks, and send advisory findings; do not edit or commit.',
  };
  const renderer = createOrchestrationDelegationRenderer(planId, options);
  const lines = agentTypes.map(
    (agentType) =>
      `- **${agentType}**: ${renderer.startAgentInstruction(agentType)} ${descriptions[agentType]}`
  );

  return `## Available Collaborative Agents

${lines.join('\n')}

Start only the roles needed for clear, separable work. Keep task selection, plan updates, and the final integrated result with the orchestrator. Send follow-up context with SendAgentMessage instead of restarting a persistent agent.
`;
}
