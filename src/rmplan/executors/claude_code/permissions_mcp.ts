/**
 * This file implements a standalone MCP server for handling interactive tool-use permissions
 * for the Claude Code executor. It provides a mechanism to prompt users for permission before
 * allowing or denying tool invocations based on user input.
 */

import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { stringify } from 'yaml';
import * as net from 'net';

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

// Unix socket connection for communication with parent process
let parentSocket: net.Socket | null = null;

// Connect to the parent process via Unix socket
function connectToParent(socketPath: string) {
  parentSocket = net.createConnection(socketPath, () => {
    // Connection established
  });

  parentSocket.on('error', (err) => {
    console.error('Socket error:', err);
    process.exit(1);
  });

  parentSocket.on('close', () => {
    process.exit(0);
  });
}

// Send a request to the parent process and wait for response
async function requestPermissionFromParent(tool_name: string, input: any): Promise<boolean> {
  if (!parentSocket) {
    throw new Error('Not connected to parent process');
  }

  return new Promise((resolve, reject) => {
    const request = {
      type: 'permission_request',
      tool_name,
      input,
    };

    // Set up one-time listener for the response
    const responseHandler = (data: Buffer) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.type === 'permission_response') {
          parentSocket!.off('data', responseHandler);
          resolve(response.approved);
        }
      } catch (err) {
        reject(err as Error);
      }
    };

    parentSocket!.on('data', responseHandler);

    // Send the request
    parentSocket!.write(JSON.stringify(request) + '\n');
  });
}

// Define the approval prompt tool
server.addTool({
  name: 'approval_prompt',
  description: 'Prompts the user for permission to execute a tool',
  parameters: PermissionInputSchema,
  execute: async ({ tool_name, input }) => {
    try {
      // Request permission from the parent process
      const approved = await requestPermissionFromParent(tool_name, input);

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
    } catch (err) {
      // If communication fails, deny by default
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              behavior: 'deny',
              message: `Permission request failed: ${err as Error}`,
            }),
          },
        ],
      };
    }
  },
});

// Start the server if this file is run directly
if (import.meta.main) {
  // Get the Unix socket path from command line argument
  const socketPath = process.argv[2];
  if (!socketPath) {
    console.error('Unix socket path must be provided as command line argument');
    process.exit(1);
  }

  // Connect to the parent process
  connectToParent(socketPath);

  // Start the MCP server in stdio mode
  await server.start({
    transportType: 'stdio',
  });
}
