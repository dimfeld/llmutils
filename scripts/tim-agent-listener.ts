#!/usr/bin/env bun

const DEFAULT_PORT = 8123;
const TARGET_PATH = '/tim-agent';

const requestedPort = Bun.argv[2] ?? process.env.TIM_AGENT_PORT ?? process.env.PORT;
const port = requestedPort ? Number.parseInt(requestedPort, 10) : DEFAULT_PORT;

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(
    `Invalid port "${requestedPort}". Pass a valid port as the first argument, TIM_AGENT_PORT, or PORT.`
  );
  process.exit(1);
}

function formatMessage(message: string | Uint8Array): string {
  if (typeof message === 'string') {
    return message;
  }
  return new TextDecoder().decode(message);
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
    open() {
      console.log(`[tim-agent-listener] client connected`);
    },
    message(_ws, message) {
      console.log(formatMessage(message));
    },
    close(_ws, code, reason) {
      console.log(`[tim-agent-listener] client disconnected code=${code} reason=${reason}`);
    },
  },
});

console.log(`[tim-agent-listener] listening on ws://localhost:${server.port}${TARGET_PATH}`);
