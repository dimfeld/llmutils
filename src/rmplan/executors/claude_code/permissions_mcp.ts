/**
 * This file implements a standalone MCP server for handling interactive tool-use permissions
 * for the Claude Code executor. It provides a mechanism to prompt users for permission before
 * allowing or denying tool invocations based on user input.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { confirm } from '@inquirer/prompts';
import { stringify } from 'yaml';

// Define the schema for the permission prompt input
export const PermissionInputSchema = {
  tool_name: z.string(),
  input: z.object({}).passthrough(),
};

// Create the MCP server
const server = new McpServer({
  name: 'permissions-server',
  version: '0.0.1',
});

// Define the approval prompt tool
server.tool(
  'approval_prompt',
  'Prompts the user for permission to execute a tool',
  PermissionInputSchema,
  async ({ tool_name, input }) => {
    // Format the input as human-readable YAML
    const formattedInput = stringify(input);

    // Prompt the user for confirmation
    const approved = await confirm({
      message: `Claude wants to run a tool:\n\nTool: ${tool_name}\nInput:\n${formattedInput}\nAllow this tool to run?`,
    });

    // Return the response based on user's decision
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            approved
              ? {
                  behavior: 'allow',
                  updatedInput: input,
                }
              : {
                  behavior: 'deny',
                  message: `User denied permission for tool: ${tool_name}`,
                }
          ),
        },
      ],
    };
  }
);

// Start the server if this file is run directly
if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
