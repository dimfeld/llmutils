import { createInterface, type Interface } from 'node:readline';
import { setActiveInputSource } from '../../../common/input_pause_registry.js';

export type TerminalInputReaderState = 'active' | 'paused' | 'stopped';

interface TerminalInputReaderOptions {
  onLine: (line: string) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

interface TerminalInputReaderStopOptions {
  unref?: boolean;
}

let activeTerminalInputReader: TerminalInputReader | undefined;

function setActiveTerminalInputReader(reader: TerminalInputReader | undefined): void {
  activeTerminalInputReader = reader;
  setActiveInputSource(reader);
}

function supportsUnref(stream: unknown): stream is { unref: () => void } {
  return typeof stream === 'object' && stream !== null && 'unref' in stream;
}

function supportsRef(stream: unknown): stream is { ref: () => void } {
  return typeof stream === 'object' && stream !== null && 'ref' in stream;
}

function logTerminalInputReaderError(error: unknown): void {
  console.error('TerminalInputReader error:', error);
}

export class TerminalInputReader {
  private readonly onLine: (line: string) => void | Promise<void>;
  private readonly onError: (error: unknown) => void;
  private readline: Interface | undefined;
  private state: TerminalInputReaderState = 'stopped';
  private partialInput = '';

  constructor(options: TerminalInputReaderOptions) {
    this.onLine = options.onLine;
    this.onError = options.onError ?? logTerminalInputReaderError;
  }

  getState(): TerminalInputReaderState {
    return this.state;
  }

  start(): boolean {
    if (!process.stdin.isTTY) {
      return false;
    }

    if (this.state === 'active') {
      return true;
    }

    if (this.state === 'paused') {
      this.resume();
      return this.getState() === 'active';
    }

    const activeReader = getActiveTerminalInputReader();
    if (activeReader && activeReader !== this) {
      activeReader.stop();
    }

    if (supportsRef(process.stdin)) {
      process.stdin.ref();
    }

    this.partialInput = '';
    this.createReadline();
    this.state = 'active';
    setActiveTerminalInputReader(this);
    return true;
  }

  pause(): void {
    if (this.state !== 'active') {
      return;
    }

    // Keep stdin referenced while prompts are active so the process does not
    // exit mid-prompt; unref is only done during full stop/cleanup.
    this.capturePartialInput();
    this.state = 'paused';
    this.closeReadline();
  }

  resume(): void {
    if (this.state !== 'paused') {
      return;
    }

    if (!process.stdin.isTTY) {
      this.stop();
      return;
    }

    if (supportsRef(process.stdin)) {
      process.stdin.ref();
    }

    const partialInput = this.partialInput;

    try {
      this.createReadline();
      this.state = 'active';
      setActiveTerminalInputReader(this);

      if (partialInput.length > 0) {
        this.readline?.write(partialInput);
      }

      this.partialInput = '';
    } catch (error: unknown) {
      this.closeReadline();
      this.state = 'paused';
      this.partialInput = partialInput;
      this.onError(error);
    }
  }

  stop(options: TerminalInputReaderStopOptions = {}): void {
    if (this.state === 'stopped') {
      return;
    }

    this.partialInput = '';
    this.state = 'stopped';
    this.closeReadline();
    if (options.unref === true) {
      process.stdin.pause();
      if (supportsUnref(process.stdin)) {
        process.stdin.unref();
      }
    }
    if (activeTerminalInputReader === this) {
      setActiveTerminalInputReader(undefined);
    }
  }

  private createReadline(): void {
    this.readline = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
    });

    this.readline.on('line', (line) => {
      if (line.length === 0) {
        return;
      }

      void Promise.resolve()
        .then(() => {
          if (this.state !== 'active') {
            return;
          }
          return this.onLine(line);
        })
        .catch((error: unknown) => {
          this.onError(error);
        });
    });

    this.readline.on('close', () => {
      this.readline = undefined;
      if (this.state === 'active') {
        // External/unexpected close while active should fully tear down reader state.
        this.partialInput = '';
        this.state = 'stopped';
      }
      if (activeTerminalInputReader === this && this.state !== 'paused') {
        setActiveTerminalInputReader(undefined);
      }
    });
  }

  private capturePartialInput(): void {
    this.partialInput = this.readline?.line ?? '';
  }

  private closeReadline(): void {
    // readline.close() emits "close" synchronously, so callers must set
    // this.state before invoking this method.
    this.readline?.close();
    this.readline = undefined;
  }
}

export function getActiveTerminalInputReader(): TerminalInputReader | undefined {
  return activeTerminalInputReader;
}
