import * as fs from 'node:fs/promises';

import { isRecord } from '../../../common/type_guards.js';
import { CLAUDE_MCP_SERVER_NAME } from './claude_mcp_protocol.js';

export interface ClaudeMcpConfig {
  readonly [key: string]: unknown;
  readonly mcpServers?: Record<string, unknown>;
}

export interface ClaudeMcpServerDefinition {
  readonly type: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Read and validate a user MCP config before the bridge allocates any resources.
 * The returned object is a new value so setup never mutates the user's file.
 */
export async function readUserMcpConfig(
  mcpConfigFile: string | undefined
): Promise<ClaudeMcpConfig> {
  if (mcpConfigFile === undefined) return {};

  let content: string;
  try {
    content = await fs.readFile(mcpConfigFile, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read Claude MCP config file ${mcpConfigFile}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Claude MCP config file ${mcpConfigFile} contains invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`Claude MCP config file ${mcpConfigFile} must contain a JSON object`);
  }
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw new Error(`Claude MCP config file ${mcpConfigFile} must define mcpServers as an object`);
  }

  return parsed;
}

export function mergeClaudeMcpConfig(
  userConfig: ClaudeMcpConfig,
  internalServer: ClaudeMcpServerDefinition
): ClaudeMcpConfig {
  const userServers = userConfig.mcpServers ?? {};
  assertClaudeMcpServerNameAvailable(userServers);

  return {
    ...userConfig,
    mcpServers: {
      ...userServers,
      [CLAUDE_MCP_SERVER_NAME]: internalServer,
    },
  };
}

export function assertClaudeMcpServerNameAvailable(userServers: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(userServers, CLAUDE_MCP_SERVER_NAME)) {
    throw new Error(
      `Claude MCP server name collision: ${CLAUDE_MCP_SERVER_NAME} is reserved for tim's internal bridge`
    );
  }
}
