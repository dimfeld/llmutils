# Tutorial: Implementing a Permissions MCP for Claude Code SDK in TypeScript

This tutorial guides you through implementing a Model Context Protocol (MCP) permissions server for the Claude Code SDK in TypeScript. The permissions MCP will handle tool permission prompts, allowing or denying tool invocations based on custom logic.

## Prerequisites

- Node.js and npm installed
- Anthropic API key
- Basic familiarity with TypeScript and the Claude Code SDK
- The `@modelcontextprotocol/server` package installed

## Step 1: Set Up Your Project

Create a new TypeScript project:

```bash
mkdir claude-mcp-permissions
cd claude-mcp-permissions
npm init -y
npm install typescript @modelcontextprotocol/server zod @anthropic-ai/sdk
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

## Step 2: Create the MCP Permissions Server

Create a `src/permissions-server.ts` file with the following code to define a permissions MCP server that checks tool invocation permissions:

```typescript
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

// Define the schema for the permission prompt input
const PermissionInputSchema = z.object({
  tool_name: z.string().describe('The tool requesting permission'),
  input: z.object({}).passthrough().describe('The input for the tool'),
});

// Create the MCP server
const server = new McpServer({
  name: 'permissions-server',
  version: '1.0.0',
});

// Define the approval prompt tool
server.tool(
  'approval_prompt',
  'Handles permission checks for tool invocations',
  PermissionInputSchema,
  async ({ tool_name, input }) => {
    // Custom permission logic
    // For this example, allow tools if input contains "allow", deny otherwise
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
  }
);

// Start the server
server.start().catch(console.error);
```

This code:

1. Imports required dependencies
2. Defines a schema for the permission input using Zod
3. Creates an MCP server named `permissions-server`
4. Implements an `approval_prompt` tool that allows tool invocations if the input contains "allow"
5. Returns a JSON-stringified payload as required by the Claude Code SDK

## Step 3: Create the MCP Configuration File

Create a `mcp-config.json` file to define the MCP server:

```json
{
  "mcpServers": {
    "permissions": {
      "command": "node",
      "args": ["dist/permissions-server.js"]
    }
  }
}
```

This configuration tells Claude Code to run the permissions server using Node.js.

## Step 4: Compile and Test the Permissions Server

Compile the TypeScript code:

```bash
npx tsc
```

Test the server by running it directly:

```bash
node dist/permissions-server.js
```

The server should start and be ready to handle MCP requests.

## Step 5: Use the Permissions MCP with Claude Code

Run Claude Code with the permissions MCP, specifying the `approval_prompt` tool:

```bash
claude -p "Test tool invocation with allow in input" \
  --mcp-config mcp-config.json \
  --permission-prompt-tool mcp__permissions__approval_prompt \
  --allowedTools "mcp__test__sample_tool"
```

In this example:

- The `--mcp-config` flag loads the permissions server
- The `--permission-prompt-tool` specifies the `approval_prompt` tool
- The `--allowedTools` flag is included to demonstrate a tool invocation (replace `mcp__test__sample_tool` with an actual tool if available)

If the input contains "allow", the tool invocation will be permitted; otherwise, it will be denied with a message.

## Step 6: Example with a Real Tool

To demonstrate with a real tool, let's assume you have a filesystem MCP server. Update `mcp-config.json`:

```json
{
  "mcpServers": {
    "permissions": {
      "command": "node",
      "args": ["dist/permissions-server.js"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./project-files"]
    }
  }
}
```

Now run Claude Code to use a filesystem tool with permission checks:

```bash
claude -p "Read file with allow in input" \
  --mcp-config mcp-config.json \
  --permission-prompt-tool mcp__permissions__approval_prompt \
  --allowedTools "mcp__filesystem__read_file"
```

The `approval_prompt` tool will check if the input contains "allow" before permitting the `read_file` tool to execute.

## Step 7: Best Practices

1. **Input Validation**: Use Zod to strictly validate input schemas.
2. **Security**: Implement robust permission logic based on your application's needs (e.g., user roles, specific tool restrictions).
3. **Error Handling**: Add error handling in the MCP server to manage edge cases.
4. **Logging**: Enable verbose logging with `--verbose` to debug issues.
5. **Testing**: Test the permissions server independently to ensure it returns correctly formatted JSON payloads.

Example with enhanced error handling:

```typescript
server.tool(
  'approval_prompt',
  'Handles permission checks for tool invocations',
  PermissionInputSchema,
  async ({ tool_name, input }) => {
    try {
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
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              behavior: 'deny',
              message: `Error in permission check: ${error.message}`,
            }),
          },
        ],
      };
    }
  }
);
```

## Step 8: Advanced Usage

To modify tool inputs, update the `updatedInput` field in the allow response. For example, to modify a file edit diff:

```typescript
server.tool(
  'approval_prompt',
  'Handles permission checks with input modification',
  PermissionInputSchema,
  async ({ tool_name, input }) => {
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
  }
);
```

This adds a comment to file content before allowing the tool to proceed.

## Conclusion

You've now implemented a permissions MCP server for the Claude Code SDK in TypeScript. This server can be extended with more complex permission logic, integrated with other MCP servers, and used to control tool access securely in your Claude Code workflows.

For more details, refer to the [Claude Code SDK documentation](https://docs.anthropic.com/en/docs/claude-code/sdk).
