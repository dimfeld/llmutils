/**
 * This file implements a standalone MCP server for handling interactive tool-use permissions
 * for the Claude Code executor. It provides a mechanism to prompt users for permission before
 * allowing or denying tool invocations based on user input.
 */

import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { confirm } from '@inquirer/prompts';
import { stringify } from 'yaml';
import chalk from 'chalk';

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
    let formattedInput = stringify(input);
    if (formattedInput.length > 500) {
      formattedInput = formattedInput.substring(0, 500) + '...';
    }

    // Prompt the user for confirmation
    const approved = await confirm({
      message: `Claude wants to run a tool:\n\nTool: ${chalk.blue(tool_name)}\nInput:\n${chalk.white(formattedInput)}\n\nAllow this tool to run?`,
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

/** FastMCP has no way to listen on port "0" and get the actual port number back,
 * so we do this instead which is prone to race conditions but should almost always work.
 *
 * A better solution would be nice but this is ok for now. */
async function findFreePort(): Promise<number> {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response('OK'),
  });

  let port = server.port!;
  await server.stop();
  return port;
}

// Start the server if this file is run directly
if (import.meta.main) {
  const port = await findFreePort();
  await server.start({
    transportType: 'httpStream',
    httpStream: {
      port,
    },
  });
  // Send the port number back to the parent process via IPC
  if (process.send) {
    process.send({ port });
  }
}
