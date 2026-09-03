import {
  createOrchestrationDelegationRenderer,
  type OrchestratedAgentType,
} from './orchestration_delegation.js';
import type { OrchestrationOptions } from './orchestration_options.js';

/** Root-only tool and lifecycle contract for enabled collaborative sessions. */
export function buildCollaborativeToolGuidance(): string {
  return `## Collaborative Agent Tools

This root session has collaborative agent tools enabled. Use them for delegated implementation, testing, TDD test writing, and advisory review work.

These \`Tim\` agent tools belong to the \`tim\` collaborative runtime. They are separate from any built-in subagent creation or messaging tools provided by your model host. Use the \`Tim\` tools for this workflow, and do not mix their agent names, lifecycle state, or messages with the host's built-in subagent system.

- **StartTimAgent** starts a persistent subagent without waiting for it to finish. Its type is one of \`implementer\`, \`tester\`, \`tdd-tests\`, or \`reviewer\`; its executor is \`claude-code\` or \`codex-cli\`; and its initial message must state the task, file scope, constraints, and expected handoff. For a multi-phase assignment, state that the agent should remain available and what completes the full assignment. A subagent can remain active across implementation, review, and follow-up turns.
- **ListTimAgents** returns the canonical names, types, executors, and visible lifecycle states for the other active agents, excluding the calling agent. Use it only when team state is unclear, a dependency needs checking, or before retrying a target; do not poll it for routine progress updates.
- **SendTimAgentMessage** sends useful context, questions, blockers, decisions, and handoffs. The runtime supplies trusted source attribution; agents must use the canonical names returned by ListTimAgents when replying.
- **StopTimAgent** is available only to the orchestrator. Use it only for explicit cancellation, an unrecoverable coordination deadlock, a safety issue, or an unresponsive agent. Do not stop an agent just because its expected work appears complete; let it finish naturally.

Use short descriptive names when a stable address helps, or omit the name to accept a generated name. After StartTimAgent returns, always use its returned canonical name. The session allows at most eight nonterminal subagents; \`orchestrator\` is reserved for the root and does not count. Agents in \`starting\`, \`running-active\`, \`running-idle\`, \`finishing\`, and \`stopping\` states all hold capacity. Starting agents remain visible while preparing and must not be assumed ready for another assignment. Finishing and stopping agents remain visible but reject new assignments.

SendTimAgentMessage reports one of three successful delivery paths: \`steered\` for the active turn, \`queued\` when input waits in the recipient FIFO, or \`started-idle-turn\` when an idle provider begins a continuation. \`queued\` means accepted; do not resend it just because delivery was not immediate.

FinishTimAgent is self-only. The root cannot call it. Let each subagent decide when its full assignment and final handoff are complete. A progress message, interim handoff, or end of one turn is not a reason to finish. Require every subagent to make a result-bearing \`Tim\` tool call: it must either send its final response to \`orchestrator\` with SendTimAgentMessage or put its final status in the FinishTimAgent message. A plain assistant response without either tool call is not a reliable handoff. The manager's terminal notification remains the lifecycle completion signal and can carry the explicit FinishTimAgent status.

## Root Shutdown

Before finishing your own orchestration turn or allowing the root session to shut down, make sure each subagent that completed its assignment made a result-bearing Tim tool call. Also make sure every subagent reached a terminal state (\`exited\` or \`failed\`). After a subagent sends its final response and needs no more work, send a message asking it to call its self-only \`FinishTimAgent\`, then wait for its terminal notification. A subagent can instead put its final status directly in that FinishTimAgent call. A \`finishing\` or \`stopping\` state is not terminal. If a subagent cannot finish after its final handoff, use \`StopTimAgent\` with the appropriate shutdown context and wait for the terminal notification. Do not shut down the root while any subagent is nonterminal.

## Agent Autonomy

Give each subagent a clear outcome, file scope, constraints, verification steps, and expected handoff. Then let it choose its own implementation steps and work independently. Treat the agent lifetime as separate from the current workflow phase. Any subagent may send progress and remain active while another phase runs, then receive more work through SendTimAgentMessage when useful. Do not request routine progress updates or repeatedly inspect its lifecycle. Send follow-up messages only when there is actionable context, a blocker, a decision, or a handoff. Do not ask a subagent to stop or finish merely because you think it should be done; allow it to finish naturally.

All agents share one working directory and see changes immediately. Before concurrent mutating work, assign disjoint file scopes or agree on one owner and an edit order for shared files. Read-only review and non-mutating inspection may overlap. Start only agents with a clear job; several agents of the same type are allowed when their scopes are safely separable.

A StartTimAgent reviewer is read-only and advisory. It may inspect evolving work, run non-mutating checks, and send findings, but it is not the formal quality gate. The authoritative review is the separate one-shot \`tim review\` command with fresh context and no collaborative tools.
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

Start only the roles needed for clear, separable work. Keep task selection, plan updates, and the final integrated result with the orchestrator. Send follow-up context with SendTimAgentMessage instead of restarting a persistent agent.
`;
}
