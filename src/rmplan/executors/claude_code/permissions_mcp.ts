/**
 * This file implements a standalone MCP server for handling interactive tool-use permissions
 * for the Claude Code executor. It provides a mechanism to prompt users for permission before
 * allowing or denying tool invocations based on user input.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

// Define the schema for the permission prompt input
export const PermissionInputSchema = z.object({
  tool_name: z.string(),
  input: z.object({}).passthrough(),
});

// Create the MCP server
const server = new McpServer({
  name: 'permissions-server',
  version: '0.0.1',
});

// Start the server if this file is run directly
if (import.meta.main) {
  server.start();
}
