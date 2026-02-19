#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createTunnelServer } from '../src/logging/tunnel_server.js';
import { createPromptRequestHandler } from '../src/logging/tunnel_prompt_handler.js';
import { TIM_OUTPUT_SOCKET } from '../src/logging/tunnel_protocol.js';

function printUsage(): void {
  console.error(`Usage:
  bun scripts/run-with-tunnel.ts [--] <command> [args...]

Examples:
  bun scripts/run-with-tunnel.ts -- tim chat
  bun scripts/run-with-tunnel.ts -- bun test src/logging/tunnel_server.test.ts`);
}

function parseCommandArgs(argv: string[]): string[] {
  const parsed = argv[0] === '--' ? argv.slice(1) : argv;
  if (parsed.length === 0) {
    printUsage();
    process.exit(1);
  }
  return parsed;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const commandArgs = parseCommandArgs(argv);
  const command = commandArgs[0];
  const args = commandArgs.slice(1);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tim-tunnel-run-'));
  const socketPath = path.join(tempDir, 'output.sock');
  const tunnelServer = await createTunnelServer(socketPath, {
    onPromptRequest: createPromptRequestHandler(),
    onMessage: (message) => {
      process.stdout.write(`[tunnel] ${JSON.stringify(message)}\n`);
    },
  });

  let child: ReturnType<typeof spawn> | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  const registerSignalForwarding = (signal: NodeJS.Signals) => {
    const handler = () => {
      if (child && child.pid && !child.killed) {
        child.kill(signal);
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  };

  registerSignalForwarding('SIGINT');
  registerSignalForwarding('SIGTERM');
  registerSignalForwarding('SIGHUP');

  try {
    child = spawn(command, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        [TIM_OUTPUT_SOCKET]: socketPath,
      },
    });

    const { code, signal } = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('exit', (exitCode, exitSignal) => {
        resolve({ code: exitCode, signal: exitSignal });
      });
    });

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exitCode = code ?? 1;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    tunnelServer.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
