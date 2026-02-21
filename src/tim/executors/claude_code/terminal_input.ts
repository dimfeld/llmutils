import { createInterface, type Interface } from 'node:readline';
import { setActiveInputSource } from '../../../common/input_pause_registry.js';

export type TerminalInputReaderState = 'active' | 'paused' | 'stopped';

interface TerminalInputReaderOptions {
  onLine: (line: string) => void | Promise<void>;
  onError?: (error: unknown) => void;
  onCloseWhileActive?: () => void;
}

let activeTerminalInputReader: TerminalInputReader | undefined;

function setActiveTerminalInputReader(reader: TerminalInputReader | undefined): void {
  activeTerminalInputReader = reader;
  setActiveInputSource(reader);
}

function logTerminalInputReaderError(error: unknown): void {
  console.error('TerminalInputReader error:', error);
}

export class TerminalInputReader {
  private readonly onLine: (line: string) => void | Promise<void>;
  private readonly onError: (error: unknown) => void;
  private readonly onCloseWhileActive: () => void;
  private readline: Interface | undefined;
  private state: TerminalInputReaderState = 'stopped';
  private partialInput = '';

  constructor(options: TerminalInputReaderOptions) {
    this.onLine = options.onLine;
    this.onError = options.onError ?? logTerminalInputReaderError;
    this.onCloseWhileActive = options.onCloseWhileActive ?? (() => {});
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

  stop(): void {
    if (this.state === 'stopped') {
      return;
    }

    this.partialInput = '';
    this.state = 'stopped';
    this.closeReadline();
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

    this.readline.on('SIGINT', () => {
      process.kill(process.pid, 'SIGINT');
    });

    this.readline.on('close', () => {
      this.readline = undefined;
      const closedWhileActive = this.state === 'active';
      if (closedWhileActive) {
        // External/unexpected close while active should fully tear down reader state.
        this.partialInput = '';
        this.state = 'stopped';
        try {
          this.onCloseWhileActive();
        } catch (error: unknown) {
          this.onError(error);
        }
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
