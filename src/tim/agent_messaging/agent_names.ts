import { randomUUID } from 'node:crypto';

import {
  agentAddressSchema,
  agentIdSchema,
  agentNameSchema,
  type AgentType,
  MAX_AGENT_NAME_LENGTH,
} from './contracts.js';
import { containsControlCharacters } from './mailbox_helpers.js';
import { MAX_MAILBOX_AGENT_ID_LENGTH } from './mailbox_protocol.js';

declare const agentIdBrand: unique symbol;
declare const agentNameBrand: unique symbol;

/** An opaque runtime identity. It is never derived from an agent name. */
export type AgentId = string & { readonly [agentIdBrand]: 'AgentId' };

/** A model-facing name, including the reserved orchestrator name. */
export type AgentName = string & { readonly [agentNameBrand]: 'AgentName' };

/** A synchronous source of opaque IDs, injected for deterministic tests. */
export type AgentIdGenerator = () => string;

/** A synchronous source of the short slug used in generated names. */
export type AgentSlugGenerator = (agentType: AgentType) => string;

export const DEFAULT_MAX_AGENT_ID_GENERATION_ATTEMPTS = 32;
export const DEFAULT_MAX_AGENT_NAME_GENERATION_ATTEMPTS = 32;

export function parseAgentId(value: unknown): AgentId | undefined {
  const result = agentIdSchema.safeParse(value);
  if (
    !result.success ||
    result.data.length > MAX_MAILBOX_AGENT_ID_LENGTH ||
    containsControlCharacters(result.data) ||
    result.data === '.' ||
    result.data === '..' ||
    result.data.includes('/') ||
    result.data.includes('\\')
  ) {
    return undefined;
  }
  return result.data as AgentId;
}

export function parseAgentAddress(value: unknown): AgentName | undefined {
  const result = agentAddressSchema.safeParse(value);
  return result.success ? (result.data as AgentName) : undefined;
}

export function parseSubagentName(value: unknown): AgentName | undefined {
  const result = agentNameSchema.safeParse(value);
  return result.success ? (result.data as AgentName) : undefined;
}

export function createDefaultAgentId(): string {
  return randomUUID();
}

export function createDefaultAgentSlug(_agentType: AgentType): string {
  return randomUUID().replaceAll('-', '').slice(0, 8);
}

/**
 * Build and validate one generated subagent name. The caller owns collision
 * handling and retry limits because only the manager knows active names.
 */
export function buildGeneratedAgentName(
  agentType: AgentType,
  slug: unknown
): AgentName | undefined {
  if (typeof slug !== 'string') {
    return undefined;
  }

  // Validate the slug as its own handle component as well as validating the
  // complete generated name. Otherwise a slug such as "-worker" would form
  // a syntactically valid but malformed name such as "tester--worker".
  if (parseAgentAddress(slug) === undefined) {
    return undefined;
  }

  const candidate = `${agentType}-${slug}`;
  if (candidate.length > MAX_AGENT_NAME_LENGTH) {
    return undefined;
  }
  return parseSubagentName(candidate);
}
