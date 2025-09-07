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

// Define the schema for the review feedback input
export const ReviewFeedbackInputSchema = z.object({
  reviewerFeedback: z
    .string()
    .describe('The output from the reviewer subagent that needs user feedback'),
});

// Create the FastMCP server
const server = new FastMCP({
  name: 'permissions-server',
  version: '0.0.1',
});

// Unix socket connection for communication with parent process
let parentSocket: net.Socket | null = null;

// Map to track pending requests by correlation ID
const pendingRequests = new Map<string, (value: any) => void>();
let requestCounter = 0;

// Generate a unique request ID
function generateRequestId(): string {
  return `req_${Date.now()}_${++requestCounter}`;
}

// Maximum JSON message size (1MB)
const MAX_JSON_SIZE = 1024 * 1024;

// Buffer for accumulating partial JSON messages
let messageBuffer = '';

// Test helper function to clean up for testing (for testing only)
export function cleanupForTests() {
  pendingRequests.clear();
  messageBuffer = '';
  if (parentSocket) {
    parentSocket.removeAllListeners();
    parentSocket = null;
  }
}

// Test helper function to set the parent socket (for testing only)
export function setParentSocket(socket: net.Socket | null) {
  parentSocket = socket;

  // Set up data handling for test sockets
  if (socket) {
    // Remove any existing listeners to avoid duplicates
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');

    // Handle incoming data from parent process
    socket.on('data', (data: Buffer) => {
      messageBuffer += data.toString();

      // Check for complete messages (ended by newline)
      let newlineIndex;
      while ((newlineIndex = messageBuffer.indexOf('\n')) !== -1) {
        const messageStr = messageBuffer.slice(0, newlineIndex);
        messageBuffer = messageBuffer.slice(newlineIndex + 1);

        if (messageStr.length > MAX_JSON_SIZE) {
          console.error('Message too large, ignoring');
          continue;
        }

        try {
          const message = JSON.parse(messageStr);
          handleParentResponse(message);
        } catch (err) {
          console.error('Failed to parse JSON message:', err);
        }
      }

      // Prevent buffer from growing too large
      if (messageBuffer.length > MAX_JSON_SIZE) {
        console.error('Message buffer too large, clearing');
        messageBuffer = '';
      }
    });

    socket.on('error', (err) => {
      console.error('Socket error:', err);
      // Reject all pending requests
      for (const [id, reject] of pendingRequests.entries()) {
        reject(new Error('Socket connection error'));
      }
      pendingRequests.clear();
    });

    socket.on('close', () => {
      // Reject all pending requests
      for (const [id, reject] of pendingRequests.entries()) {
        reject(new Error('Socket connection closed'));
      }
      pendingRequests.clear();
    });
  } else {
    // Clear pending requests when socket is null (but don't reject them in cleanup)
    pendingRequests.clear();
    messageBuffer = '';
  }
}

// Connect to the parent process via Unix socket
function connectToParent(socketPath: string) {
  parentSocket = net.createConnection(socketPath, () => {
    // Connection established
  });

  // Handle incoming data from parent process
  parentSocket.on('data', (data: Buffer) => {
    messageBuffer += data.toString();

    // Check for complete messages (ended by newline)
    let newlineIndex;
    while ((newlineIndex = messageBuffer.indexOf('\n')) !== -1) {
      const messageStr = messageBuffer.slice(0, newlineIndex);
      messageBuffer = messageBuffer.slice(newlineIndex + 1);

      if (messageStr.length > MAX_JSON_SIZE) {
        console.error('Message too large, ignoring');
        continue;
      }

      try {
        const message = JSON.parse(messageStr);
        handleParentResponse(message);
      } catch (err) {
        console.error('Failed to parse JSON message:', err);
      }
    }

    // Prevent buffer from growing too large
    if (messageBuffer.length > MAX_JSON_SIZE) {
      console.error('Message buffer too large, clearing');
      messageBuffer = '';
    }
  });

  parentSocket.on('error', (err) => {
    console.error('Socket error:', err);
    // Reject all pending requests
    for (const [id, reject] of pendingRequests.entries()) {
      reject(new Error('Socket connection error'));
    }
    pendingRequests.clear();
    process.exit(1);
  });

  parentSocket.on('close', () => {
    // Reject all pending requests
    for (const [id, reject] of pendingRequests.entries()) {
      reject(new Error('Socket connection closed'));
    }
    pendingRequests.clear();
    process.exit(0);
  });
}

// Handle responses from the parent process
function handleParentResponse(message: any) {
  if (!message.requestId) {
    console.error('Received message without requestId:', message);
    return;
  }

  const resolver = pendingRequests.get(message.requestId);
  if (!resolver) {
    console.error('No pending request found for requestId:', message.requestId);
    return;
  }

  pendingRequests.delete(message.requestId);

  if (message.type === 'permission_response') {
    resolver(message.approved);
  } else if (message.type === 'review_feedback_response') {
    resolver(message.userFeedback || '');
  } else {
    console.error('Unknown response type:', message.type);
    resolver(null);
  }
}

// Send a request to the parent process and wait for response
async function requestPermissionFromParent(tool_name: string, input: any): Promise<boolean> {
  if (!parentSocket) {
    throw new Error('Not connected to parent process');
  }

  return new Promise((resolve, reject) => {
    const requestId = generateRequestId();
    const request = {
      type: 'permission_request',
      requestId,
      tool_name,
      input,
    };

    // Store the resolver for this request
    pendingRequests.set(requestId, resolve);

    // Set up a timeout to clean up pending requests
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Permission request timed out'));
    }, 600000); // 10 minute timeout

    // Override the resolver to also clear the timeout
    const originalResolver = pendingRequests.get(requestId)!;
    pendingRequests.set(requestId, (value) => {
      clearTimeout(timeout);
      originalResolver(value);
    });

    try {
      // Send the request
      parentSocket!.write(JSON.stringify(request) + '\n');
    } catch (err) {
      clearTimeout(timeout);
      pendingRequests.delete(requestId);
      reject(err as Error);
    }
  });
}

// Send a review feedback request to the parent process and wait for response
export async function requestReviewFeedbackFromParent(reviewerFeedback: string): Promise<string> {
  if (!parentSocket) {
    throw new Error('Not connected to parent process');
  }

  return new Promise((resolve, reject) => {
    const requestId = generateRequestId();
    const request = {
      type: 'review_feedback_request',
      requestId,
      reviewerFeedback,
    };

    // Store the resolver for this request
    pendingRequests.set(requestId, resolve);

    // Set up a timeout to clean up pending requests
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Review feedback request timed out'));
    }, 30000); // 30 second timeout

    // Override the resolver to also clear the timeout
    const originalResolver = pendingRequests.get(requestId)!;
    pendingRequests.set(requestId, (value) => {
      clearTimeout(timeout);
      originalResolver(value);
    });

    try {
      // Send the request
      parentSocket!.write(JSON.stringify(request) + '\n');
    } catch (err) {
      clearTimeout(timeout);
      pendingRequests.delete(requestId);
      reject(err as Error);
    }
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

// Conditionally define the review feedback prompt tool based on command line argument
if (process.argv.includes('--enable-review-feedback')) {
  server.addTool({
    name: 'review_feedback_prompt',
    description: 'Prompts the user for feedback on reviewer output',
    parameters: ReviewFeedbackInputSchema,
    execute: async ({ reviewerFeedback }) => {
      try {
        // Request review feedback from the parent process
        const userFeedback = await requestReviewFeedbackFromParent(reviewerFeedback);

        // Return the user's feedback as text
        return {
          content: [
            {
              type: 'text',
              text: userFeedback,
            },
          ],
        };
      } catch (err) {
        // If communication fails, return an empty string
        return {
          content: [
            {
              type: 'text',
              text: '', // Return empty string on error, not error message
            },
          ],
        };
      }
    },
  });
}

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
  process.stdin.on('close', () => parentSocket?.end());

  // Start the MCP server in stdio mode
  await server.start({
    transportType: 'stdio',
  });
}
