import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Interface } from 'node:readline';
import { ModuleMocker } from '../../../testing.ts';
import {
  getActiveInputSource,
  setActiveInputSource,
} from '../../../common/input_pause_registry.ts';

type FakeLineHandler = (line: string) => void;
type FakeSignalHandler = () => void;

class FakeReadline {
  line = '';
  closed = false;
  writes: string[] = [];
  private readonly lineHandlers: FakeLineHandler[] = [];
  private readonly closeHandlers: FakeSignalHandler[] = [];

  on(event: string, handler: FakeLineHandler | FakeSignalHandler): this {
    if (event === 'line') {
      this.lineHandlers.push(handler as FakeLineHandler);
    } else if (event === 'close') {
      this.closeHandlers.push(handler as FakeSignalHandler);
    }
    return this;
  }

  close(): void {
    this.closed = true;
    this.emitClose();
  }

  write(content: string): void {
    this.writes.push(content);
  }

  emitLine(line: string): void {
    for (const handler of this.lineHandlers) {
      handler(line);
    }
  }

  emitClose(): void {
    for (const handler of this.closeHandlers) {
      handler();
    }
  }
}

const moduleMocker = new ModuleMocker(import.meta);
const createdInterfaces: FakeReadline[] = [];
const createInterfaceOptions: unknown[] = [];
const createInterfaceMock = mock((options: unknown): Interface => {
  const fake = new FakeReadline();
  createdInterfaces.push(fake);
  createInterfaceOptions.push(options);
  return fake as unknown as Interface;
});

await moduleMocker.mock('node:readline', () => ({
  createInterface: createInterfaceMock,
}));

const { TerminalInputReader, getActiveTerminalInputReader } = await import('./terminal_input.ts');

const originalStdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const originalStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

function restoreTTYDescriptors(): void {
  if (originalStdinTTY) {
    Object.defineProperty(process.stdin, 'isTTY', originalStdinTTY);
  }
  if (originalStdoutTTY) {
    Object.defineProperty(process.stdout, 'isTTY', originalStdoutTTY);
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('TerminalInputReader', () => {
  beforeEach(() => {
    getActiveTerminalInputReader()?.stop({ unref: true });
    setActiveInputSource(undefined);
    createInterfaceMock.mockClear();
    createdInterfaces.length = 0;
    createInterfaceOptions.length = 0;
    setTTY(false);
  });

  afterAll(() => {
    restoreTTYDescriptors();
    moduleMocker.clear();
  });

  it('start is a no-op when stdin is not a TTY', () => {
    const reader = new TerminalInputReader({ onLine: () => {} });

    const started = reader.start();

    expect(started).toBe(false);
    expect(reader.getState()).toBe('stopped');
    expect(getActiveTerminalInputReader()).toBeUndefined();
    expect(createInterfaceMock).not.toHaveBeenCalled();
  });

  it('tracks active reader on start and clears it on stop', () => {
    setTTY(true);
    const reader = new TerminalInputReader({ onLine: () => {} });

    expect(reader.start()).toBe(true);
    expect(reader.getState()).toBe('active');
    expect(getActiveTerminalInputReader()).toBe(reader);
    expect(getActiveInputSource()).toBe(reader);
    expect(createInterfaceMock).toHaveBeenCalledTimes(1);

    reader.stop();

    expect(reader.getState()).toBe('stopped');
    expect(getActiveTerminalInputReader()).toBeUndefined();
    expect(getActiveInputSource()).toBeUndefined();
    expect(createdInterfaces[0]?.closed).toBe(true);
  });

  it('creates readline in terminal mode with stdout output', () => {
    setTTY(true);
    const reader = new TerminalInputReader({ onLine: () => {} });

    reader.start();

    const options = createInterfaceOptions[0] as {
      input?: unknown;
      output?: unknown;
      terminal?: boolean;
    };
    expect(options.terminal).toBe(true);
    expect(options.input).toBe(process.stdin);
    expect(options.output).toBe(process.stdout);

    reader.stop();
  });

  it('starting a second reader stops the first active reader', () => {
    setTTY(true);
    const firstReader = new TerminalInputReader({ onLine: () => {} });
    const secondReader = new TerminalInputReader({ onLine: () => {} });

    expect(firstReader.start()).toBe(true);
    expect(firstReader.getState()).toBe('active');
    expect(getActiveTerminalInputReader()).toBe(firstReader);

    expect(secondReader.start()).toBe(true);

    expect(firstReader.getState()).toBe('stopped');
    expect(secondReader.getState()).toBe('active');
    expect(getActiveTerminalInputReader()).toBe(secondReader);
    expect(getActiveInputSource()).toBe(secondReader);
    expect(createdInterfaces[0]?.closed).toBe(true);

    secondReader.stop();
  });

  it('start while paused resumes and restores partial input', () => {
    setTTY(true);
    const reader = new TerminalInputReader({ onLine: () => {} });
    reader.start();
    const firstInterface = createdInterfaces[0];
    firstInterface.line = 'resume me';

    reader.pause();
    expect(reader.getState()).toBe('paused');

    expect(reader.start()).toBe(true);

    expect(reader.getState()).toBe('active');
    expect(createInterfaceMock).toHaveBeenCalledTimes(2);
    expect(createdInterfaces[1]?.writes).toEqual(['resume me']);

    reader.stop();
  });

  it('start is idempotent while already active', () => {
    setTTY(true);
    const reader = new TerminalInputReader({ onLine: () => {} });

    expect(reader.start()).toBe(true);
    expect(reader.start()).toBe(true);

    expect(reader.getState()).toBe('active');
    expect(createInterfaceMock).toHaveBeenCalledTimes(1);

    reader.stop();
  });

  it('pause/resume preserves partial input and restores it to a new readline instance', () => {
    setTTY(true);
    const reader = new TerminalInputReader({ onLine: () => {} });
    reader.start();

    const firstInterface = createdInterfaces[0];
    firstInterface.line = 'partial message';

    reader.pause();
    expect(reader.getState()).toBe('paused');
    expect(firstInterface.closed).toBe(true);

    reader.resume();
    expect(reader.getState()).toBe('active');
    expect(createInterfaceMock).toHaveBeenCalledTimes(2);
    expect(createdInterfaces[1]?.writes).toEqual(['partial message']);

    reader.stop();
  });

  it('transitions to stopped when readline closes externally', () => {
    setTTY(true);
    const reader = new TerminalInputReader({ onLine: () => {} });
    reader.start();

    expect(getActiveTerminalInputReader()).toBe(reader);
    createdInterfaces[0].emitClose();

    expect(reader.getState()).toBe('stopped');
    expect(getActiveTerminalInputReader()).toBeUndefined();
  });

  it('stop is safe when never started and pause/resume are no-ops while stopped', () => {
    const reader = new TerminalInputReader({ onLine: () => {} });

    reader.pause();
    reader.resume();
    reader.stop();
    reader.stop();

    expect(reader.getState()).toBe('stopped');
    expect(getActiveTerminalInputReader()).toBeUndefined();
  });

  it('invokes onLine for non-empty lines only', async () => {
    setTTY(true);
    const onLine = mock(() => Promise.resolve());
    const reader = new TerminalInputReader({ onLine });
    reader.start();

    const iface = createdInterfaces[0];
    iface.emitLine('');
    iface.emitLine('follow up instruction');
    await flushMicrotasks();

    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onLine).toHaveBeenCalledWith('follow up instruction');

    reader.stop();
  });

  it('forwards onLine errors to onError handler', async () => {
    setTTY(true);
    const expectedError = new Error('write failed');
    const onError = mock(() => {});
    const reader = new TerminalInputReader({
      onLine: () => Promise.reject(expectedError),
      onError,
    });
    reader.start();

    createdInterfaces[0].emitLine('message');
    await flushMicrotasks();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expectedError);

    reader.stop();
  });

  it('skips deferred onLine invocation after pausing before microtask runs', async () => {
    setTTY(true);
    const onLine = mock(() => Promise.resolve());
    const reader = new TerminalInputReader({ onLine });
    reader.start();

    createdInterfaces[0].emitLine('queued line');
    reader.pause();
    await flushMicrotasks();

    expect(onLine).not.toHaveBeenCalled();
    expect(reader.getState()).toBe('paused');

    reader.stop();
  });

  it('logs onLine errors to console.error when onError is omitted', async () => {
    setTTY(true);
    const consoleErrorSpy = mock(() => {});
    const originalConsoleError = console.error;
    console.error = consoleErrorSpy as typeof console.error;

    try {
      const expectedError = new Error('default error path');
      const reader = new TerminalInputReader({
        onLine: () => Promise.reject(expectedError),
      });
      reader.start();

      createdInterfaces[0].emitLine('trigger error');
      await flushMicrotasks();

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy.mock.calls[0]?.[0]).toBe('TerminalInputReader error:');
      expect(consoleErrorSpy.mock.calls[0]?.[1]).toBe(expectedError);

      reader.stop();
    } finally {
      console.error = originalConsoleError;
    }
  });

  it('stop does not call stdin.unref by default', () => {
    setTTY(true);
    const unrefSpy = mock(() => {});
    const pauseSpy = mock(() => {});
    const originalUnref = (process.stdin as { unref?: () => void }).unref;
    const originalPause = process.stdin.pause;
    (process.stdin as { unref?: () => void }).unref = unrefSpy;
    process.stdin.pause = pauseSpy as typeof process.stdin.pause;

    try {
      const reader = new TerminalInputReader({ onLine: () => {} });
      reader.start();

      reader.stop();

      expect(unrefSpy).not.toHaveBeenCalled();
      expect(pauseSpy).not.toHaveBeenCalled();
    } finally {
      (process.stdin as { unref?: () => void }).unref = originalUnref;
      process.stdin.pause = originalPause;
    }
  });

  it('stop calls stdin.unref when explicitly requested', () => {
    setTTY(true);
    const unrefSpy = mock(() => {});
    const pauseSpy = mock(() => {});
    const originalUnref = (process.stdin as { unref?: () => void }).unref;
    const originalPause = process.stdin.pause;
    (process.stdin as { unref?: () => void }).unref = unrefSpy;
    process.stdin.pause = pauseSpy as typeof process.stdin.pause;

    try {
      const reader = new TerminalInputReader({ onLine: () => {} });
      reader.start();

      reader.stop({ unref: true });

      expect(unrefSpy).toHaveBeenCalledTimes(1);
      expect(pauseSpy).toHaveBeenCalledTimes(1);
    } finally {
      (process.stdin as { unref?: () => void }).unref = originalUnref;
      process.stdin.pause = originalPause;
    }
  });
});
