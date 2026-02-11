#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { createTunnelServer } from '../src/logging/tunnel_server.js';
import { createPromptRequestHandler } from '../src/logging/tunnel_prompt_handler.js';
import { TIM_OUTPUT_SOCKET } from '../src/logging/tunnel_protocol.js';
import { createTunnelAdapter } from '../src/logging/tunnel_client.js';
import { runWithLogger } from '../src/logging.js';
import {
  promptCheckbox,
  promptConfirm,
  promptInput,
  promptSelect,
  isPromptTimeoutError,
} from '../src/common/input.js';

type PromptType = 'confirm' | 'select' | 'input' | 'checkbox';

interface HarnessOptions {
  child: boolean;
  type: PromptType;
  timeoutMs?: number;
}

function printUsage(): void {
  console.log(`Usage:
  bun scripts/manual-tunnel-prompt-harness.ts [--type <confirm|select|input|checkbox>] [--timeout-ms <ms>]

Examples:
  bun scripts/manual-tunnel-prompt-harness.ts --type confirm
  bun scripts/manual-tunnel-prompt-harness.ts --type select
  bun scripts/manual-tunnel-prompt-harness.ts --type input --timeout-ms 3000
  bun scripts/manual-tunnel-prompt-harness.ts --type checkbox`);
}

function parseOptions(argv: string[]): HarnessOptions {
  let child = false;
  let type: PromptType = 'confirm';
  let timeoutMs: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--child':
        child = true;
        break;
      case '--type': {
        const value = argv[i + 1];
        if (!value) {
          throw new Error('Missing value for --type');
        }
        if (
          value !== 'confirm' &&
          value !== 'select' &&
          value !== 'input' &&
          value !== 'checkbox'
        ) {
          throw new Error(`Invalid prompt type: ${value}`);
        }
        type = value;
        i += 1;
        break;
      }
      case '--timeout-ms': {
        const value = argv[i + 1];
        if (!value) {
          throw new Error('Missing value for --timeout-ms');
        }
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid --timeout-ms value: ${value}`);
        }
        timeoutMs = parsed;
        i += 1;
        break;
      }
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { child, type, timeoutMs };
}

async function runChildPrompt(type: PromptType, timeoutMs?: number): Promise<void> {
  const socketPath = process.env[TIM_OUTPUT_SOCKET];
  if (!socketPath) {
    throw new Error(`Missing ${TIM_OUTPUT_SOCKET} in child environment`);
  }

  const adapter = await createTunnelAdapter(socketPath);

  try {
    const value = await runWithLogger(adapter, async () => {
      switch (type) {
        case 'confirm':
          return await promptConfirm({
            message: 'Manual harness: Continue?',
            default: true,
            timeoutMs,
          });
        case 'select':
          return await promptSelect({
            message: 'Manual harness: Select one option',
            choices: [
              { name: 'Option A', value: 'a', description: 'First option' },
              { name: 'Option B', value: 'b', description: 'Second option' },
              { name: 'Option C', value: 'c', description: 'Third option' },
            ],
            default: 'b',
            timeoutMs,
          });
        case 'input':
          return await promptInput({
            message: 'Manual harness: Enter text',
            default: 'example',
            timeoutMs,
          });
        case 'checkbox':
          return await promptCheckbox({
            message: 'Manual harness: Select one or more options',
            choices: [
              { name: 'Alpha', value: 'alpha' },
              { name: 'Beta', value: 'beta', checked: true },
              { name: 'Gamma', value: 'gamma' },
            ],
            timeoutMs,
          });
      }
    });

    console.log(JSON.stringify({ status: 'answered', promptType: type, value }));
  } catch (err) {
    if (isPromptTimeoutError(err)) {
      console.log(
        JSON.stringify({
          status: 'timeout',
          promptType: type,
          error: err instanceof Error ? err.message : String(err),
        })
      );
      return;
    }

    console.error(
      JSON.stringify({
        status: 'error',
        promptType: type,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    process.exitCode = 1;
  } finally {
    await adapter.destroy();
  }
}

async function runParentHarness(type: PromptType, timeoutMs?: number): Promise<void> {
  const socketPath = path.join(
    os.tmpdir(),
    `manual-tunnel-prompt-harness-${process.pid}-${Date.now()}.sock`
  );

  const tunnelServer = await createTunnelServer(socketPath, {
    onPromptRequest: createPromptRequestHandler(),
  });

  const scriptPath = fileURLToPath(import.meta.url);
  const childArgs = [scriptPath, '--child', '--type', type];
  if (timeoutMs != null) {
    childArgs.push('--timeout-ms', String(timeoutMs));
  }

  console.log(`[harness] tunnel server listening on ${socketPath}`);
  console.log(`[harness] spawning child with prompt type "${type}"`);
  if (timeoutMs != null) {
    console.log(`[harness] timeout enabled: ${timeoutMs}ms`);
  }

  const child = spawn(process.execPath, childArgs, {
    env: {
      ...process.env,
      [TIM_OUTPUT_SOCKET]: socketPath,
    },
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[child] ${chunk.toString()}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[child] ${chunk.toString()}`);
  });

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('exit', (exitCode, exitSignal) => {
      resolve({ code: exitCode, signal: exitSignal });
    });
  });

  tunnelServer.close();

  if (signal) {
    throw new Error(`Child exited due to signal: ${signal}`);
  }

  if (code !== 0) {
    throw new Error(`Child exited with code ${code}`);
  }

  console.log('[harness] child completed');
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.child) {
    await runChildPrompt(options.type, options.timeoutMs);
    return;
  }

  await runParentHarness(options.type, options.timeoutMs);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
