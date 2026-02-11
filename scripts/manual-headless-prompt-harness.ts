#!/usr/bin/env bun

/**
 * Manual testing harness for headless prompt dual-channel racing.
 *
 * Starts a WebSocket server that:
 * 1. Displays received prompt_request messages from a HeadlessAdapter client
 * 2. Allows sending prompt_response messages back via stdin
 * 3. Shows prompt_answered messages when the prompt resolves
 * 4. Displays all other structured messages for visibility
 *
 * Usage:
 *   bun scripts/manual-headless-prompt-harness.ts [port]
 *
 * Then run a tim agent command with TIM_HEADLESS_URL=ws://localhost:<port>/tim-agent
 * (or use the default port 8123 which matches the HeadlessAdapter default).
 *
 * When a prompt_request appears, type one of:
 *   r <requestId> <JSON value>   - Respond with a value
 *   e <requestId> <error msg>    - Respond with an error
 *   q                            - Quit
 */

import process from 'node:process';
import readline from 'node:readline';
import type { ServerWebSocket } from 'bun';
import type {
  HeadlessMessage,
  HeadlessPromptResponseServerMessage,
} from '../src/logging/headless_protocol.js';
import type {
  PromptRequestMessage,
  PromptAnsweredMessage,
  StructuredMessage,
} from '../src/logging/structured_messages.js';
import type { TunnelMessage } from '../src/logging/tunnel_protocol.js';

const DEFAULT_PORT = 8123;
const TARGET_PATH = '/tim-agent';

const requestedPort = Bun.argv[2] ?? process.env.TIM_AGENT_PORT ?? process.env.PORT;
const port = requestedPort ? Number.parseInt(String(requestedPort), 10) : DEFAULT_PORT;

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(
    `Invalid port "${requestedPort}". Pass a valid port as the first argument, TIM_AGENT_PORT, or PORT.`
  );
  process.exit(1);
}

/** Currently connected client, if any. Only one client at a time. */
let activeClient: ServerWebSocket<unknown> | undefined;

/** Track active prompt requests by requestId for display. */
const activePrompts = new Map<string, PromptRequestMessage>();

function formatTimestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function printPromptRequest(msg: PromptRequestMessage): void {
  const config = msg.promptConfig;
  console.log('');
  console.log(`  [${formatTimestamp()}] PROMPT REQUEST`);
  console.log(`    Request ID:  ${msg.requestId}`);
  console.log(`    Type:        ${msg.promptType}`);
  console.log(`    Message:     ${config.message}`);
  if (config.default !== undefined) {
    console.log(`    Default:     ${JSON.stringify(config.default)}`);
  }
  if (config.choices) {
    console.log('    Choices:');
    for (const choice of config.choices) {
      const desc = choice.description ? ` - ${choice.description}` : '';
      const checked = choice.checked ? ' [checked]' : '';
      console.log(`      ${JSON.stringify(choice.value)}: ${choice.name}${desc}${checked}`);
    }
  }
  if (msg.timeoutMs) {
    console.log(`    Timeout:     ${msg.timeoutMs}ms`);
  }
  console.log('');
  console.log(`  To respond:  r ${msg.requestId} <value as JSON>`);
  console.log(`  To error:    e ${msg.requestId} <error message>`);
  console.log('');
}

function printPromptAnswered(msg: PromptAnsweredMessage): void {
  console.log('');
  console.log(`  [${formatTimestamp()}] PROMPT ANSWERED`);
  console.log(`    Request ID:  ${msg.requestId}`);
  console.log(`    Type:        ${msg.promptType}`);
  console.log(`    Value:       ${JSON.stringify(msg.value)}`);
  console.log(`    Source:      ${msg.source}`);
  console.log('');
}

function printStructuredMessage(msg: StructuredMessage): void {
  console.log(`  [${formatTimestamp()}] structured/${msg.type}: ${JSON.stringify(msg)}`);
}

function handleIncomingMessage(data: string): void {
  let parsed: HeadlessMessage;
  try {
    parsed = JSON.parse(data);
  } catch {
    console.log(`  [${formatTimestamp()}] [unparseable message] ${data.slice(0, 200)}`);
    return;
  }

  switch (parsed.type) {
    case 'session_info':
      console.log('');
      console.log(`  [${formatTimestamp()}] SESSION INFO`);
      console.log(`    Command:     ${parsed.command}`);
      if (parsed.planId) console.log(`    Plan ID:     ${parsed.planId}`);
      if (parsed.planTitle) console.log(`    Plan Title:  ${parsed.planTitle}`);
      if (parsed.workspacePath) console.log(`    Workspace:   ${parsed.workspacePath}`);
      console.log('');
      break;

    case 'replay_start':
      console.log(`  [${formatTimestamp()}] --- replay start ---`);
      break;

    case 'replay_end':
      console.log(`  [${formatTimestamp()}] --- replay end ---`);
      break;

    case 'output': {
      const tunnelMsg: TunnelMessage = parsed.message;
      if (tunnelMsg.type === 'structured') {
        const structured = tunnelMsg.message;
        if (structured.type === 'prompt_request') {
          activePrompts.set(structured.requestId, structured);
          printPromptRequest(structured);
        } else if (structured.type === 'prompt_answered') {
          activePrompts.delete(structured.requestId);
          printPromptAnswered(structured);
        } else {
          printStructuredMessage(structured);
        }
      } else if (
        tunnelMsg.type === 'log' ||
        tunnelMsg.type === 'error' ||
        tunnelMsg.type === 'warn'
      ) {
        console.log(`  [${formatTimestamp()}] ${tunnelMsg.type}: ${tunnelMsg.args.join(' ')}`);
      } else if (tunnelMsg.type === 'stdout' || tunnelMsg.type === 'stderr') {
        process.stdout.write(`  [${formatTimestamp()}] ${tunnelMsg.type}: ${tunnelMsg.data}`);
      }
      break;
    }
  }
}

function sendPromptResponse(requestId: string, value?: unknown, error?: string): void {
  if (!activeClient) {
    console.log('  [error] No client connected');
    return;
  }

  const response: HeadlessPromptResponseServerMessage = {
    type: 'prompt_response',
    requestId,
  };

  if (error !== undefined) {
    response.error = error;
  } else {
    response.value = value;
  }

  activeClient.send(JSON.stringify(response));
  console.log(
    `  [${formatTimestamp()}] Sent prompt_response for ${requestId}: ${error ? `error="${error}"` : `value=${JSON.stringify(value)}`}`
  );
}

const server = Bun.serve({
  port,
  fetch(req, serverRef) {
    const url = new URL(req.url);

    if (url.pathname === TARGET_PATH) {
      if (serverRef.upgrade(req)) {
        return;
      }
      return new Response('WebSocket upgrade failed\n', { status: 400 });
    }

    return new Response(`Expected WebSocket path ${TARGET_PATH}\n`, { status: 404 });
  },
  websocket: {
    open(ws) {
      if (activeClient) {
        console.log(`  [${formatTimestamp()}] Previous client replaced by new connection`);
      }
      activeClient = ws;
      activePrompts.clear();
      console.log(`  [${formatTimestamp()}] Client connected`);
    },
    message(_ws, message) {
      const data = typeof message === 'string' ? message : new TextDecoder().decode(message);
      handleIncomingMessage(data);
    },
    close(_ws, code, reason) {
      activeClient = undefined;
      console.log(`  [${formatTimestamp()}] Client disconnected code=${code} reason=${reason}`);
      console.log(`  [${formatTimestamp()}] Active prompts still pending: ${activePrompts.size}`);
    },
  },
});

console.log(`[headless-prompt-harness] Listening on ws://localhost:${server.port}${TARGET_PATH}`);
console.log('');
console.log('Commands:');
console.log('  r <requestId> <JSON value>   - Respond to a prompt with a value');
console.log('  e <requestId> <error msg>    - Respond to a prompt with an error');
console.log('  l                            - List active prompts');
console.log('  q                            - Quit');
console.log('');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> ',
});

rl.prompt();

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    rl.prompt();
    return;
  }

  if (trimmed === 'q' || trimmed === 'quit') {
    console.log('Shutting down...');
    rl.close();
    server.stop();
    process.exit(0);
  }

  if (trimmed === 'l' || trimmed === 'list') {
    if (activePrompts.size === 0) {
      console.log('  No active prompts');
    } else {
      for (const [id, prompt] of activePrompts) {
        console.log(`  ${id}: ${prompt.promptType} - "${prompt.promptConfig.message}"`);
      }
    }
    rl.prompt();
    return;
  }

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0];
  const requestId = parts[1];

  if (!requestId) {
    console.log('  Usage: r <requestId> <value> | e <requestId> <error>');
    rl.prompt();
    return;
  }

  if (cmd === 'r' || cmd === 'respond') {
    const valueStr = parts.slice(2).join(' ') || 'true';
    let value: unknown;
    try {
      value = JSON.parse(valueStr);
    } catch {
      // Treat as raw string if not valid JSON
      value = valueStr;
    }
    sendPromptResponse(requestId, value);
  } else if (cmd === 'e' || cmd === 'error') {
    const errorMsg = parts.slice(2).join(' ') || 'Error from harness';
    sendPromptResponse(requestId, undefined, errorMsg);
  } else {
    console.log(`  Unknown command: ${cmd}`);
    console.log('  Commands: r (respond), e (error), l (list), q (quit)');
  }

  rl.prompt();
});

rl.on('close', () => {
  server.stop();
  process.exit(0);
});
