# Tutorial: Implementing a Permissions MCP for Claude Code SDK using FastMCP with SSE Transport in TypeScript

This tutorial guides you through implementing a Model Context Protocol (MCP) permissions server for the Claude Code SDK using the FastMCP framework in TypeScript, configured to use Server-Sent Events (SSE) transport for remote communication. The permissions MCP will handle tool permission prompts, allowing or denying tool invocations based on custom logic.

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

## Step 2: Create the FastMCP Permissions Server with SSE Transport

Create a `src/permissions-server.ts` file with the following code to define a permissions MCP server using FastMCP with SSE transport:

```typescript
import { FastMCP } from 'fastmcp';
import { z } from 'zod';

// Define the schema for the permission prompt input
const PermissionInputSchema = z.object({
  tool_name: z.string().describe('The tool requesting permission'),
  input: z.object({}).passthrough().describe('The input for the tool'),
});

// Create the FastMCP server
const server = new FastMCP({
  name: 'permissions-server',
  version: '1.0.0',
  ping: {
    enabled: true, // Ensure pings are enabled for SSE
    intervalMs: 10000, // Ping every 10 seconds
    logLevel: 'debug',
  },
});

// Define the approval prompt tool
server.addTool({
  name: 'approval_prompt',
  description: 'Handles permission checks for tool invocations',
  parameters: PermissionInputSchema,
  execute: async ({ tool_name, input }, { log }) => {
    log.info('Checking permissions for tool', { tool_name });
    const isAllowed = JSON.stringify(input).includes('allow');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            isAllowed
              ? {
                  behavior: 'allow',
                  updatedInput: input,
                }
              : {
                  behavior: 'deny',
                  message: `Permission denied for tool ${tool_name}: input does not contain 'allow'`,
                }
          ),
        },
      ],
    };
  },
});

// Start the server with SSE transport
server.start({
  transportType: 'sse',
  sse: {
    port: 8080,
  },
});
```

This code:

1. Imports `FastMCP` and `zod`
2. Defines a schema for the permission input using Zod
3. Creates a FastMCP server named `permissions-server` with ping configuration for SSE
4. Adds an `approval_prompt` tool that allows tool invocations if the input contains "allow"
5. Uses SSE transport to listen on `http://localhost:8080/sse`
6. Returns a JSON-stringified payload as required by the Claude Code SDK

## Step 3: Create the MCP Configuration File

Create a `mcp-config.json` file to define the MCP server for SSE:

```json
{
  "mcpServers": {
    "permissions": {
      "url": "http://localhost:8080/sse"
    }
  }
}
```

This configuration specifies the SSE endpoint for the permissions server.

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

The server should start and listen for SSE connections at `http://localhost:8080/sse`.

## Step 5: Use the Permissions MCP with Claude Code

Run Claude Code with the permissions MCP, specifying the `approval_prompt` tool:

```bash
claude -p "Test tool invocation with allow in input" \
  --mcp-config mcp-config.json \
  --permission-prompt-tool mcp__permissions__approval_prompt \
  --allowedTools "mcp__test__sample_tool"
```

In this example:

- The `--mcp-config` flag loads the permissions server via the SSE URL
- The `--permission-prompt-tool` specifies the `approval_prompt` tool
- The `--allowedTools` flag demonstrates a tool invocation (replace `mcp__test__sample_tool` with an actual tool if available)

If the input contains "allow", the tool invocation will be permitted; otherwise, it will be denied with a message.

## Step 6: Example with a Real Tool

To demonstrate with a filesystem MCP server, update `mcp-config.json`:

```json
{
  "mcpServers": {
    "permissions": {
      "type": "sse",
      "url": "http://localhost:8080/sse"
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

The `approval_prompt` tool will check if the input contains "allow" before permitting the `read_file` tool to execute.

## Step 7: Best Practices with FastMCP and SSE

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

3. **Logging**: Use FastMCP's `log` object for debugging, especially useful for monitoring SSE connections.
4. **Ping Configuration**: Ensure pings are enabled for SSE to maintain connection health, as configured in the server setup.
5. **Testing**: Use `npx fastmcp dev` or `npx fastmcp inspect` to test and debug your server. For SSE, verify connectivity by checking the `/sse` endpoint.

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

## Step 9: Connecting to the SSE Server

Connect to the permissions server using an SSE client:

```typescript
import { Client, SSEClientTransport } from '@modelcontextprotocol/sdk/client';

const client = new Client(
  {
    name: 'example-client',
    version: '1.0.0',
  },
  {
    capabilities: {},
  }
);

const transport = new SSEClientTransport(new URL('http://localhost:8080/sse'));
await client.connect(transport);
```

This client connects to the SSE endpoint, enabling remote communication with the permissions server.

## Conclusion

You've implemented a permissions MCP server for the Claude Code SDK using FastMCP in TypeScript with SSE transport. FastMCP simplifies development with its intuitive APIs and built-in best practices, while SSE enables efficient remote communication. Extend this server with complex permission logic, integrate with other MCP servers, or leverage FastMCP's features like resource templates and prompts for advanced workflows.

For more details, refer to the [FastMCP GitHub repository](https://github.com/punkpeye/fastmcp) and the [Claude Code SDK documentation](https://docs.anthropic.com/en/docs/claude-code/sdk).
