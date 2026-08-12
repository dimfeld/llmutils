import * as z from 'zod/v4';

export const AGENT_TYPES = ['implementer', 'tester', 'tdd-tests', 'reviewer'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];
export const agentTypeSchema = z.enum(AGENT_TYPES);

export const AGENT_EXECUTORS = ['claude-code', 'codex-cli'] as const;
export type AgentExecutor = (typeof AGENT_EXECUTORS)[number];
export const agentExecutorSchema = z.enum(AGENT_EXECUTORS);

export const AGENT_RUNTIME_ROLES = ['orchestrator', 'subagent'] as const;
export type AgentRuntimeRole = (typeof AGENT_RUNTIME_ROLES)[number];
export const agentRuntimeRoleSchema = z.enum(AGENT_RUNTIME_ROLES);

export const NONTERMINAL_AGENT_LIFECYCLE_STATES = [
  'starting',
  'running-active',
  'running-idle',
  'finishing',
  'stopping',
] as const;
export type NonterminalAgentLifecycleState = (typeof NONTERMINAL_AGENT_LIFECYCLE_STATES)[number];
export const nonterminalAgentLifecycleStateSchema = z.enum(NONTERMINAL_AGENT_LIFECYCLE_STATES);

export const TERMINAL_AGENT_LIFECYCLE_STATES = ['exited', 'failed'] as const;
export type TerminalAgentLifecycleState = (typeof TERMINAL_AGENT_LIFECYCLE_STATES)[number];
export const terminalAgentLifecycleStateSchema = z.enum(TERMINAL_AGENT_LIFECYCLE_STATES);

export const AGENT_LIFECYCLE_STATES = [
  ...NONTERMINAL_AGENT_LIFECYCLE_STATES,
  ...TERMINAL_AGENT_LIFECYCLE_STATES,
] as const;
export type AgentLifecycleState = (typeof AGENT_LIFECYCLE_STATES)[number];
export const agentLifecycleStateSchema = z.enum(AGENT_LIFECYCLE_STATES);

const NONTERMINAL_AGENT_LIFECYCLE_STATE_SET: ReadonlySet<string> = new Set(
  NONTERMINAL_AGENT_LIFECYCLE_STATES
);
const TERMINAL_AGENT_LIFECYCLE_STATE_SET: ReadonlySet<string> = new Set(
  TERMINAL_AGENT_LIFECYCLE_STATES
);

export function isNonterminalAgentLifecycleState(
  value: unknown
): value is NonterminalAgentLifecycleState {
  return typeof value === 'string' && NONTERMINAL_AGENT_LIFECYCLE_STATE_SET.has(value);
}

export function isTerminalAgentLifecycleState(
  value: unknown
): value is TerminalAgentLifecycleState {
  return typeof value === 'string' && TERMINAL_AGENT_LIFECYCLE_STATE_SET.has(value);
}

export const SEND_AGENT_MESSAGE_ACKNOWLEDGEMENTS = [
  'steered',
  'queued',
  'started-idle-turn',
] as const;
export type SendAgentMessageAcknowledgement = (typeof SEND_AGENT_MESSAGE_ACKNOWLEDGEMENTS)[number];
export const sendAgentMessageAcknowledgementSchema = z.enum(SEND_AGENT_MESSAGE_ACKNOWLEDGEMENTS);

export const STOP_AGENT_ACKNOWLEDGEMENTS = [
  'graceful-requested',
  'forced',
  'already-stopping',
] as const;
export type StopAgentAcknowledgement = (typeof STOP_AGENT_ACKNOWLEDGEMENTS)[number];
export const stopAgentAcknowledgementSchema = z.enum(STOP_AGENT_ACKNOWLEDGEMENTS);

export const ORCHESTRATOR_AGENT_NAME = 'orchestrator' as const;
export const MAX_AGENT_NAME_LENGTH = 48;
export const MAX_SUBAGENTS_PER_SESSION = 8;
export const MAX_AGENT_MESSAGE_BYTES = 65_536;
export const MAX_PENDING_MESSAGES_PER_RECIPIENT = 100;

const AGENT_ADDRESS_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** A model-facing agent address. The reserved orchestrator address is valid. */
export const agentAddressSchema = z
  .string()
  .min(1)
  .max(MAX_AGENT_NAME_LENGTH)
  .regex(
    AGENT_ADDRESS_PATTERN,
    'Agent names must use lowercase ASCII letters, digits, and hyphens, with alphanumeric boundaries'
  );

/** A custom name accepted by StartAgent and StopAgent. */
export const agentNameSchema = agentAddressSchema.refine(
  (value: string): boolean => value !== ORCHESTRATOR_AGENT_NAME,
  'The orchestrator name is reserved'
);

export const agentIdSchema = z.string().min(1);

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export const agentMessageContentSchema = z.string().superRefine((value: string, ctx) => {
  const byteLength = utf8ByteLength(value);
  if (byteLength > MAX_AGENT_MESSAGE_BYTES) {
    ctx.addIssue({
      code: 'custom',
      message: `Agent message content must be at most ${MAX_AGENT_MESSAGE_BYTES} UTF-8 bytes`,
    });
  }
});

export const startAgentArgumentsSchema = z
  .object({
    name: agentNameSchema.optional(),
    type: agentTypeSchema,
    executor: agentExecutorSchema,
    initialMessage: agentMessageContentSchema,
  })
  .strict();
export type StartAgentArguments = z.infer<typeof startAgentArgumentsSchema>;

export const startAgentResultSchema = z
  .object({
    name: agentNameSchema,
    id: agentIdSchema,
    type: agentTypeSchema,
    executor: agentExecutorSchema,
    state: nonterminalAgentLifecycleStateSchema,
  })
  .strict();
export type StartAgentResult = z.infer<typeof startAgentResultSchema>;

export const listAgentsArgumentsSchema = z.object({}).strict();
export type ListAgentsArguments = z.infer<typeof listAgentsArgumentsSchema>;

const orchestratorAgentSummarySchema = z
  .object({
    name: z.literal(ORCHESTRATOR_AGENT_NAME),
    id: agentIdSchema,
    role: z.literal('orchestrator'),
    executor: agentExecutorSchema,
    state: nonterminalAgentLifecycleStateSchema,
  })
  .strict();

const subagentSummarySchema = z
  .object({
    name: agentNameSchema,
    id: agentIdSchema,
    role: z.literal('subagent'),
    type: agentTypeSchema,
    executor: agentExecutorSchema,
    state: nonterminalAgentLifecycleStateSchema,
  })
  .strict();

export const agentSummarySchema = z.discriminatedUnion('role', [
  orchestratorAgentSummarySchema,
  subagentSummarySchema,
]);
export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const listAgentsResultSchema = z
  .object({
    agents: z.array(agentSummarySchema),
  })
  .strict();
export type ListAgentsResult = z.infer<typeof listAgentsResultSchema>;

export const sendAgentMessageArgumentsSchema = z
  .object({
    name: agentAddressSchema,
    message: agentMessageContentSchema,
  })
  .strict();
export type SendAgentMessageArguments = z.infer<typeof sendAgentMessageArgumentsSchema>;

export const sendAgentMessageResultSchema = z
  .object({
    name: agentAddressSchema,
    delivery: sendAgentMessageAcknowledgementSchema,
  })
  .strict();
export type SendAgentMessageResult = z.infer<typeof sendAgentMessageResultSchema>;

export const stopAgentArgumentsSchema = z
  .object({
    name: agentNameSchema,
    message: agentMessageContentSchema.optional(),
    force: z.boolean().optional(),
  })
  .strict();
export type StopAgentArguments = z.infer<typeof stopAgentArgumentsSchema>;

export const stopAgentResultSchema = z
  .object({
    name: agentNameSchema,
    mode: stopAgentAcknowledgementSchema,
    state: agentLifecycleStateSchema,
  })
  .strict();
export type StopAgentResult = z.infer<typeof stopAgentResultSchema>;

export const finishAgentArgumentsSchema = z
  .object({
    message: agentMessageContentSchema.optional(),
  })
  .strict();
export type FinishAgentArguments = z.infer<typeof finishAgentArgumentsSchema>;

export const finishAgentResultSchema = z
  .object({
    state: z.literal('finishing'),
  })
  .strict();
export type FinishAgentResult = z.infer<typeof finishAgentResultSchema>;
