import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { vi } from 'vitest';
import * as yaml from 'yaml';
import type { PlanSchema } from '../planSchema.js';

export async function writePlanFixture(planFilePath: string, plan: PlanSchema): Promise<void> {
  const { details, ...planWithoutDetails } = plan;
  const yamlContent = yaml.stringify(planWithoutDetails);
  let fullContent = '---\n';
  fullContent +=
    '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';
  fullContent += yamlContent;
  fullContent += '---\n';

  if (details) {
    fullContent += `\n${details}`;
    if (!details.endsWith('\n')) {
      fullContent += '\n';
    }
  }

  await fs.writeFile(planFilePath, fullContent, 'utf8');
}

export function createStreamingProcessMock(overrides?: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  killedByInactivity?: boolean;
  stdin?: { write: (...args: any[]) => any; end: (...args: any[]) => any };
}) {
  return {
    stdin:
      overrides?.stdin ??
      ({
        write: vi.fn((_value: string) => {}),
        end: vi.fn(async () => {}),
      } as const),
    result: Promise.resolve({
      exitCode: overrides?.exitCode ?? 0,
      stdout: overrides?.stdout ?? '',
      stderr: overrides?.stderr ?? '',
      signal: overrides?.signal ?? null,
      killedByInactivity: overrides?.killedByInactivity ?? false,
    }),
    kill: vi.fn(() => {}),
  };
}

export async function sendSinglePromptAndWaitForTest(streamingProcess: any, content: string) {
  const inputMessage = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  });
  streamingProcess.stdin.write(`${inputMessage}\n`);
  await streamingProcess.stdin.end();
  return streamingProcess.result;
}

export function mockBunStdinText(value: string): () => void {
  const bunAny = Bun as any;
  const descriptor = Object.getOwnPropertyDescriptor(bunAny, 'stdin');
  const original = bunAny.stdin;
  const replacement = { text: async () => value };

  if (descriptor?.configurable) {
    Object.defineProperty(bunAny, 'stdin', {
      value: replacement,
      configurable: true,
    });
    return () => {
      Object.defineProperty(bunAny, 'stdin', descriptor);
    };
  }

  if (descriptor?.writable) {
    bunAny.stdin = replacement;
    return () => {
      bunAny.stdin = original;
    };
  }

  throw new Error('Unable to override Bun.stdin in test environment.');
}

export function mockIsTTY(value: boolean): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  return () => {
    if (descriptor) {
      Object.defineProperty(process.stdin, 'isTTY', descriptor);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  };
}

export function makeSubagentPlanFixture(): PlanSchema {
  return {
    id: 42,
    title: 'Test Plan for Subagent',
    goal: 'Build a widget',
    details: 'Detailed description of the widget to build',
    status: 'pending',
    tasks: [
      {
        title: 'Implement the widget',
        description: 'Write the widget code',
        done: false,
      },
      {
        title: 'Test the widget',
        description: 'Write tests for the widget code',
        done: false,
      },
    ],
  };
}

export async function makeSubagentTestPaths(prefix: string, plan: PlanSchema) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const tasksDir = path.join(tempDir, 'tasks');
  await fs.mkdir(tasksDir, { recursive: true });
  const planFilePath = path.join(tasksDir, '42-test-plan.plan.md');
  await writePlanFixture(planFilePath, plan);
  return { tempDir, tasksDir, planFilePath };
}
