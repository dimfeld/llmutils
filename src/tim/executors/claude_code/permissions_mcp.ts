/**
 * This file implements a standalone MCP server for handling interactive tool-use permissions
 * for the Claude Code executor. It provides a mechanism to prompt users for permission before
 * allowing or denying tool invocations based on user input.
 */

import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import * as net from 'net';
import * as fs from 'fs';

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

// Map to track pending requests by correlation ID
const pendingRequests = new Map<string, (value: any) => void>();
let requestCounter = 0;

export interface PermissionResponseData {
  approved: boolean;
  updatedInput?: any;
}

// Generate a unique request ID
function generateRequestId(): string {
  return `req_${Date.now()}_${++requestCounter}`;
}

// Maximum JSON message size (1MB)
const MAX_JSON_SIZE = 1024 * 1024;

// Buffer for accumulating partial JSON messages
let messageBuffer = '';
let logFilePath: string | undefined;

function formatLogValue(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function writeLog(message: string, ...values: unknown[]): void {
  if (!logFilePath) {
    return;
  }

  const renderedValues = values.map(formatLogValue);
  const line = `[${new Date().toISOString()}] ${[message, ...renderedValues].join(' ')}\n`;

  try {
    fs.appendFileSync(logFilePath, line);
  } catch (err) {
    console.error('Failed to write permissions MCP log:', err);
  }
}

function configureLogging(nextLogFilePath: string | undefined): void {
  logFilePath = nextLogFilePath;
  if (!logFilePath) {
    return;
  }

  writeLog('Permissions MCP log initialized:', logFilePath);

  process.on('uncaughtException', (err: Error) => {
    writeLog('Uncaught exception:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    writeLog('Unhandled rejection:', reason);
  });
}

// Test helper function to clean up for testing (for testing only)
export function cleanupForTests() {
  pendingRequests.clear();
  messageBuffer = '';
  logFilePath = undefined;
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
          writeLog('Message too large, ignoring:', messageStr.length);
          console.error('Message too large, ignoring');
          continue;
        }

        try {
          const message = JSON.parse(messageStr);
          handleParentResponse(message);
        } catch (err) {
          writeLog('Failed to parse JSON message:', err);
          console.error('Failed to parse JSON message:', err);
        }
      }

      // Prevent buffer from growing too large
      if (messageBuffer.length > MAX_JSON_SIZE) {
        writeLog('Message buffer too large, clearing:', messageBuffer.length);
        console.error('Message buffer too large, clearing');
        messageBuffer = '';
      }
    });

    socket.on('error', (err) => {
      writeLog('Socket error:', err);
      console.error('Socket error:', err);
      // Reject all pending requests
      for (const [, reject] of pendingRequests.entries()) {
        reject(new Error('Socket connection error'));
      }
      pendingRequests.clear();
    });

    socket.on('close', () => {
      writeLog('Socket closed');
      // Reject all pending requests
      for (const [, reject] of pendingRequests.entries()) {
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
  writeLog('Connecting to parent socket:', socketPath);
  parentSocket = net.createConnection(socketPath, () => {
    writeLog('Connected to parent socket');
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
        writeLog('Message too large, ignoring:', messageStr.length);
        console.error('Message too large, ignoring');
        continue;
      }

      try {
        const message = JSON.parse(messageStr);
        handleParentResponse(message);
      } catch (err) {
        writeLog('Failed to parse JSON message:', err);
        console.error('Failed to parse JSON message:', err);
      }
    }

    // Prevent buffer from growing too large
    if (messageBuffer.length > MAX_JSON_SIZE) {
      writeLog('Message buffer too large, clearing:', messageBuffer.length);
      console.error('Message buffer too large, clearing');
      messageBuffer = '';
    }
  });

  parentSocket.on('error', (err) => {
    writeLog('Socket error:', err);
    console.error('Socket error:', err);
    // Reject all pending requests
    for (const [, reject] of pendingRequests.entries()) {
      reject(new Error('Socket connection error'));
    }
    pendingRequests.clear();
    process.exit(1);
  });

  parentSocket.on('close', () => {
    writeLog('Socket closed');
    // Reject all pending requests
    for (const [, reject] of pendingRequests.entries()) {
      reject(new Error('Socket connection closed'));
    }
    pendingRequests.clear();
    process.exit(0);
  });
}

// Handle responses from the parent process
function handleParentResponse(message: any) {
  if (!message.requestId) {
    writeLog('Received message without requestId:', message);
    console.error('Received message without requestId:', message);
    return;
  }

  const resolver = pendingRequests.get(message.requestId);
  if (!resolver) {
    writeLog('No pending request found for requestId:', message.requestId);
    console.error('No pending request found for requestId:', message.requestId);
    return;
  }

  pendingRequests.delete(message.requestId);

  if (message.type === 'permission_response') {
    writeLog('Received permission response:', {
      requestId: message.requestId,
      approved: message.approved,
      hasUpdatedInput: message.updatedInput !== undefined,
    });
    resolver({
      approved: message.approved,
      updatedInput: message.updatedInput,
    });
  } else {
    writeLog('Unknown response type:', message.type);
    console.error('Unknown response type:', message.type);
    resolver({ approved: false });
  }
}

// Send a request to the parent process and wait for response
async function requestPermissionFromParent(
  tool_name: string,
  input: any
): Promise<PermissionResponseData> {
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
    writeLog('Sending permission request:', { requestId, tool_name, input });

    // Set up a timeout to clean up pending requests
    const timeout = setTimeout(
      () => {
        pendingRequests.delete(requestId);
        writeLog('Permission request timed out:', { requestId, tool_name });
        reject(new Error('Permission request timed out'));
      },
      1000 * 60 * 600
    ); // 600 minute timeout -- we have another timeout mechanism for normal use

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
      writeLog('Failed to send permission request:', err);
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
      const response = await requestPermissionFromParent(tool_name, input);
      writeLog('Permission request completed:', { tool_name, approved: response.approved });

      // Return the response based on user's decision
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              response.approved
                ? {
                    behavior: 'allow',
                    updatedInput: response.updatedInput ?? input,
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
      writeLog('Permission request failed:', err);
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
  const nextLogFilePath = process.argv[3];
  configureLogging(nextLogFilePath);
  if (!socketPath) {
    writeLog('Unix socket path was not provided');
    console.error('Unix socket path must be provided as command line argument');
    process.exit(1);
  }

  // Connect to the parent process
  connectToParent(socketPath);
  process.stdin.on('close', () => parentSocket?.end());

  // Start the MCP server in stdio mode
  writeLog('Starting permissions MCP server');
  await server.start({
    transportType: 'stdio',
  });
}
