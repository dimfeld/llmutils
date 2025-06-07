/**
 * This file implements a standalone MCP server for handling interactive tool-use permissions
 * for the Claude Code executor. It provides a mechanism to prompt users for permission before
 * allowing or denying tool invocations based on user input.
 */

import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { confirm } from '@inquirer/prompts';
import { stringify } from 'yaml';

// Define the schema for the permission prompt input
export const PermissionInputSchema = z.object({
  tool_name: z.string().describe('The tool requesting permission'),
  input: z.object({}).passthrough().describe('The input for the tool'),
});

// Create the FastMCP server
const server = new FastMCP({
  name: 'permissions-server',
  version: '0.0.1',
});

// Define the approval prompt tool
server.addTool({
  name: 'approval_prompt',
  description: 'Prompts the user for permission to execute a tool',
  parameters: PermissionInputSchema,
  execute: async ({ tool_name, input }) => {
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
  },
});

// Start the server if this file is run directly
if (import.meta.main) {
  const port = await server.start({
    transportType: 'sse',
    sse: {
      port: 0, // Let the OS assign an available port
    },
  });

  // Send the port number back to the parent process via IPC
  if (process.send) {
    process.send({ port });
  }
}
