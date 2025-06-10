# Tutorial: Implementing a Permissions MCP for Claude Code SDK using FastMCP with stdio Transport in TypeScript

This tutorial guides you through implementing a Model Context Protocol (MCP) permissions server for the Claude Code SDK using the FastMCP framework in TypeScript, configured to use stdio transport for direct communication with Claude Code. The permissions MCP will handle tool permission prompts, allowing or denying tool invocations based on user confirmation via Unix sockets.

## Prerequisites

- Node.js and npm installed
- Anthropic API key
- Basic familiarity with TypeScript and the Claude Code SDK
- The `fastmcp`, `@modelcontextprotocol/sdk`, and `zod` packages installed

## Step 1: Set Up Your Project

Create a new TypeScript project:

```bash
mkdir claude-fastmcp-permissions
cd claude-fastmcp-permissions
npm init -y
npm install typescript fastmcp @modelcontextprotocol/sdk zod @anthropic-ai/sdk
npx tsc --init
```

Update `tsconfig.json` to include:

```json
{
  "compilerOptions": {
    "target": "es2018",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

## Step 2: Create the FastMCP Permissions Server with stdio Transport

Create a `src/permissions-server.ts` file with the following code to define a permissions MCP server using FastMCP with stdio transport:

```typescript
import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import * as net from 'net';

// Define the schema for the permission prompt input
const PermissionInputSchema = z.object({
  tool_name: z.string().describe('The tool requesting permission'),
  input: z.object({}).passthrough().describe('The input for the tool'),
});

// Create the FastMCP server
const server = new FastMCP({
  name: 'permissions-server',
  version: '1.0.0',
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
        reject(err);
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
if (require.main === module) {
  // Get the Unix socket path from command line argument
  const socketPath = process.argv[2];
  if (!socketPath) {
    console.error('Unix socket path must be provided as command line argument');
    process.exit(1);
  }

  // Connect to the parent process
  connectToParent(socketPath);

  // Start the MCP server in stdio mode
  server.start({
    transportType: 'stdio',
  });
}
```

This code:

1. Imports `FastMCP`, `zod`, and Node.js `net` module
2. Defines a schema for the permission input using Zod
3. Creates a FastMCP server named `permissions-server`
4. Sets up Unix socket communication with the parent process (Claude Code executor)
5. Adds an `approval_prompt` tool that forwards permission requests to the parent process
6. Uses stdio transport for direct communication with Claude Code
7. Returns a JSON-stringified payload as required by the Claude Code SDK

## Step 3: Create the MCP Configuration File

Create a `mcp-config.json` file to define the MCP server for stdio:

```json
{
  "mcpServers": {
    "permissions": {
      "type": "stdio",
      "command": [
        "node",
        "dist/permissions-server.js",
        "/path/to/unix/socket"
      ]
    }
  }
}
```

This configuration tells Claude Code to spawn the permissions server using stdio transport, passing the Unix socket path as a command line argument.

## Step 4: Compile and Test the Permissions Server

Compile the TypeScript code:

```bash
npx tsc
```

Test the server using FastMCP's CLI:

```bash
npx fastmcp dev src/permissions-server.ts
```

Alternatively, inspect the server with MCP Inspector:

```bash
npx fastmcp inspect src/permissions-server.ts
```

The server should start in stdio mode and connect to the Unix socket provided by the parent process.

## Step 5: Use the Permissions MCP with Claude Code

Run Claude Code with the permissions MCP, specifying the `approval_prompt` tool:

```bash
claude -p "Test tool invocation with allow in input" \
  --mcp-config mcp-config.json \
  --permission-prompt-tool mcp__permissions__approval_prompt \
  --allowedTools "mcp__test__sample_tool"
```

In this example:

- The `--mcp-config` flag tells Claude Code to spawn the permissions server in stdio mode
- The `--permission-prompt-tool` specifies the `approval_prompt` tool
- The `--allowedTools` flag demonstrates a tool invocation (replace `mcp__test__sample_tool` with an actual tool if available)

When Claude Code attempts to use a tool, the permissions server will forward the request to the parent process via Unix socket, which will prompt the user for confirmation.

## Step 6: Example with a Real Tool

To demonstrate with a filesystem MCP server, ensure your `mcp-config.json` includes the stdio configuration:

```json
{
  "mcpServers": {
    "permissions": {
      "type": "stdio",
      "command": [
        "node",
        "dist/permissions-server.js",
        "/path/to/unix/socket"
      ]
    }
  }
}
```

Run Claude Code to use a filesystem tool with permission checks:

```bash
claude -p "Read file with allow in input" \
  --mcp-config mcp-config.json \
  --permission-prompt-tool mcp__permissions__approval_prompt \
  --allowedTools "mcp__filesystem__read_file"
```

The `approval_prompt` tool will forward the permission request to the parent process, which will prompt the user for confirmation before permitting the `read_file` tool to execute.

## Step 7: Best Practices with FastMCP and stdio

1. **Input Validation**: Use Zod for strict input validation, as shown in the schema.
2. **Error Handling**: Use FastMCP's `UserError` for user-facing errors:

```typescript
import { UserError } from 'fastmcp';

server.addTool({
  name: 'approval_prompt',
  description: 'Handles permission checks for tool invocations',
  parameters: PermissionInputSchema,
  execute: async ({ tool_name, input }, { log }) => {
    try {
      log.info('Checking permissions for tool', { tool_name });
      const isAllowed = JSON.stringify(input).includes('allow');
      if (!isAllowed) {
        throw new UserError(
          `Permission denied for tool ${tool_name}: input does not contain 'allow'`
        );
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              behavior: 'allow',
              updatedInput: input,
            }),
          },
        ],
      };
    } catch (error) {
      log.error('Permission check failed', { error });
      throw error instanceof UserError
        ? error
        : new UserError(`Error in permission check: ${error.message}`);
    }
  },
});
```

3. **Logging**: Use FastMCP's `log` object for debugging.
4. **Socket Communication**: Ensure proper error handling for Unix socket communication.
5. **Testing**: Use `npx fastmcp dev` or `npx fastmcp inspect` to test and debug your server in stdio mode.

## Step 8: Advanced Usage with Input Modification

Modify tool inputs in the `allow` response, e.g., to add a prefix to file content:

```typescript
server.addTool({
  name: 'approval_prompt',
  description: 'Handles permission checks with input modification',
  parameters: PermissionInputSchema,
  execute: async ({ tool_name, input }, { log }) => {
    log.info('Checking permissions for tool', { tool_name });
    const isAllowed = JSON.stringify(input).includes('allow');
    if (!isAllowed) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              behavior: 'deny',
              message: `Permission denied for tool ${tool_name}`,
            }),
          },
        ],
      };
    }

    // Modify input (example: add a prefix to file content)
    const updatedInput = {
      ...input,
      content: input.content ? `// Approved by permissions\n${input.content}` : input.content,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            behavior: 'allow',
            updatedInput,
          }),
        },
      ],
    };
  },
});
```

## Step 9: How the Parent Process Handles Permission Requests

The parent process (Claude Code executor) creates a Unix socket server to handle permission requests:

```typescript
import * as net from 'net';
import { confirm } from '@inquirer/prompts';

// Create Unix socket server
const server = net.createServer((socket) => {
  socket.on('data', async (data) => {
    const message = JSON.parse(data.toString());
    
    if (message.type === 'permission_request') {
      const { tool_name, input } = message;
      
      // Prompt the user for confirmation
      const approved = await confirm({
        message: `Claude wants to run tool: ${tool_name}. Allow?`,
      });
      
      // Send response back to MCP server
      socket.write(JSON.stringify({
        type: 'permission_response',
        approved,
      }) + '\n');
    }
  });
});

server.listen(socketPath);
```

This creates an interactive prompt for the user to approve or deny tool usage.

## Conclusion

You've implemented a permissions MCP server for the Claude Code SDK using FastMCP in TypeScript with stdio transport. FastMCP simplifies development with its intuitive APIs and built-in best practices, while stdio transport enables direct communication with Claude Code. The Unix socket approach avoids HTTP timeout issues and provides reliable communication for interactive permission prompts.

This architecture allows:
- Real-time user confirmation for tool usage
- No timeout issues when users take time to respond
- Direct integration with Claude Code's MCP system
- Secure communication between processes

For more details, refer to the [FastMCP GitHub repository](https://github.com/punkpeye/fastmcp) and the [Claude Code SDK documentation](https://docs.anthropic.com/en/docs/claude-code/sdk).
