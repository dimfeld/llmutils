import * as z from 'zod/v4';
import {
  ORCHESTRATOR_AGENT_NAME,
  agentIdSchema,
  agentNameSchema,
  agentRuntimeRoleSchema,
  agentTypeSchema,
} from './contracts.js';
import type {
  AgentIdentity,
  OrchestratorIdentity,
  SubagentIdentity,
} from './agent_manager_types.js';

export const TIM_AGENT_MESSAGING_DIR = 'TIM_AGENT_MESSAGING_DIR' as const;
export const TIM_AGENT_ID = 'TIM_AGENT_ID' as const;
export const TIM_AGENT_NAME = 'TIM_AGENT_NAME' as const;
export const TIM_AGENT_TYPE = 'TIM_AGENT_TYPE' as const;
export const TIM_AGENT_ROLE = 'TIM_AGENT_ROLE' as const;

export const INTERNAL_AGENT_ENVIRONMENT_VARIABLES = [
  TIM_AGENT_MESSAGING_DIR,
  TIM_AGENT_ID,
  TIM_AGENT_NAME,
  TIM_AGENT_TYPE,
  TIM_AGENT_ROLE,
] as const;
export type InternalAgentEnvironmentVariable =
  (typeof INTERNAL_AGENT_ENVIRONMENT_VARIABLES)[number];

const agentMessagingDirectorySchema = z.string().min(1);
const orchestratorRoleSchema = agentRuntimeRoleSchema.extract(['orchestrator']);
const subagentRoleSchema = agentRuntimeRoleSchema.extract(['subagent']);

const orchestratorEnvironmentIdentitySchema = z
  .object({
    messagingDirectory: agentMessagingDirectorySchema,
    id: agentIdSchema,
    name: z.literal(ORCHESTRATOR_AGENT_NAME),
    role: orchestratorRoleSchema,
  })
  .strict();

const subagentEnvironmentIdentitySchema = z
  .object({
    messagingDirectory: agentMessagingDirectorySchema,
    id: agentIdSchema,
    name: agentNameSchema,
    type: agentTypeSchema,
    role: subagentRoleSchema,
  })
  .strict();

export const agentEnvironmentIdentitySchema = z.discriminatedUnion('role', [
  orchestratorEnvironmentIdentitySchema,
  subagentEnvironmentIdentitySchema,
]);

export type AgentEnvironmentIdentity = z.infer<typeof agentEnvironmentIdentitySchema>;

export type OrchestratorEnvironmentIdentity = Extract<
  AgentEnvironmentIdentity,
  { role: 'orchestrator' }
>;
export type SubagentEnvironmentIdentity = Extract<AgentEnvironmentIdentity, { role: 'subagent' }>;

export function createAgentEnvironmentIdentity(
  messagingDirectory: string,
  identity: OrchestratorIdentity
): OrchestratorEnvironmentIdentity;
export function createAgentEnvironmentIdentity(
  messagingDirectory: string,
  identity: SubagentIdentity
): SubagentEnvironmentIdentity;
export function createAgentEnvironmentIdentity(
  messagingDirectory: string,
  identity: AgentIdentity
): AgentEnvironmentIdentity {
  return agentEnvironmentIdentitySchema.parse({
    messagingDirectory,
    id: identity.id,
    name: identity.name,
    role: identity.role,
    ...(identity.role === 'subagent' ? { type: identity.type } : {}),
  });
}

export function readAgentEnvironmentIdentity(
  env: Record<string, string | undefined> = process.env
): AgentEnvironmentIdentity | undefined {
  const values = {
    messagingDirectory: env[TIM_AGENT_MESSAGING_DIR],
    id: env[TIM_AGENT_ID],
    name: env[TIM_AGENT_NAME],
    type: env[TIM_AGENT_TYPE],
    role: env[TIM_AGENT_ROLE],
  };

  if (Object.values(values).every((value: string | undefined): boolean => value === undefined)) {
    return undefined;
  }

  const role = agentRuntimeRoleSchema.safeParse(values.role);
  if (role.success && role.data === 'orchestrator' && values.type === undefined) {
    return agentEnvironmentIdentitySchema.parse({
      messagingDirectory: values.messagingDirectory,
      id: values.id,
      name: values.name,
      role: values.role,
    });
  }

  return agentEnvironmentIdentitySchema.parse(values);
}

export function withAgentEnvironmentIdentity(
  inheritedEnv: Record<string, string | undefined>,
  identity: AgentEnvironmentIdentity
): Record<string, string> {
  const parsedIdentity = agentEnvironmentIdentitySchema.parse(identity);
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env[TIM_AGENT_MESSAGING_DIR] = parsedIdentity.messagingDirectory;
  env[TIM_AGENT_ID] = parsedIdentity.id;
  env[TIM_AGENT_NAME] = parsedIdentity.name;
  env[TIM_AGENT_ROLE] = parsedIdentity.role;
  delete env[TIM_AGENT_TYPE];
  if (parsedIdentity.role === 'subagent') {
    env[TIM_AGENT_TYPE] = parsedIdentity.type;
  }

  return env;
}
