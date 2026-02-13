import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import {
  logSpawn,
  spawnAndLogOutput,
  spawnWithStreamingIO,
  setDebug,
  setQuiet,
  debug,
  quiet,
  createLineSplitter,
} from './process';
import { runWithLogger } from '../logging.ts';
import type { LoggerAdapter } from '../logging/adapter.ts';
import type { StructuredMessage } from '../logging/structured_messages.ts';

describe('process utilities', () => {
  let originalDebug: boolean;
  let originalQuiet: boolean;

  beforeEach(() => {
    // Save original state
    originalDebug = debug;
    originalQuiet = quiet;
  });

  afterEach(() => {
    // Restore original state
    setDebug(originalDebug);
    setQuiet(originalQuiet);
  });

  describe('logSpawn', () => {
    it('should execute commands successfully', async () => {
      const proc = logSpawn(['echo', 'hello']);
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    });

    it('should respect debug flag', () => {
      setDebug(true);
      expect(debug).toBe(true);

      setDebug(false);
      expect(debug).toBe(false);
    });

    it('should respect quiet flag', () => {
      setQuiet(true);
      expect(quiet).toBe(true);

      setQuiet(false);
      expect(quiet).toBe(false);
    });

    it('should handle cwd option', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-logspawn-'));

      try {
        const proc = logSpawn(['pwd'], {
          cwd: tempDir,
          stdout: 'pipe',
        });

        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout as ReadableStream).text();

        expect(exitCode).toBe(0);
        expect(await fs.realpath(stdout.trim())).toBe(await fs.realpath(tempDir));
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should modify stdio options when quiet is enabled', async () => {
      setQuiet(true);

      const proc = logSpawn(['echo', 'test'], {
        stdout: 'inherit', // Should be changed to 'ignore' by logSpawn
        stderr: 'inherit', // Should be changed to 'ignore' by logSpawn
      });

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    });
  });

  describe('spawnAndLogOutput', () => {
    it('captures raw stdout and does not send structured output when quiet is true', async () => {
      const captured: StructuredMessage[] = [];
      const adapter: LoggerAdapter = {
        log: () => {},
        error: () => {},
        warn: () => {},
        writeStdout: () => {},
        writeStderr: () => {},
        debugLog: () => {},
        sendStructured: (message: StructuredMessage) => {
          captured.push(message);
        },
      };

      await runWithLogger(adapter, async () => {
        const result = await spawnAndLogOutput(['echo', 'hello'], {
          formatStdout: () => ({
            type: 'workflow_progress',
            timestamp: '2026-02-08T00:00:00.000Z',
            message: 'formatted',
          }),
          quiet: true,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('hello');
      });

      expect(captured).toEqual([]);
    });

    it('captures raw stdout and skips structured arrays when quiet is true', async () => {
      const captured: StructuredMessage[] = [];
      const adapter: LoggerAdapter = {
        log: () => {},
        error: () => {},
        warn: () => {},
        writeStdout: () => {},
        writeStderr: () => {},
        debugLog: () => {},
        sendStructured: (message: StructuredMessage) => {
          captured.push(message);
        },
      };

      await runWithLogger(adapter, async () => {
        const result = await spawnAndLogOutput(['echo', 'hello'], {
          formatStdout: () => [
            {
              type: 'workflow_progress',
              timestamp: '2026-02-08T00:00:00.000Z',
              message: 'first',
            },
            {
              type: 'workflow_progress',
              timestamp: '2026-02-08T00:00:00.000Z',
              message: 'second',
            },
          ],
          quiet: true,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('hello');
      });

      expect(captured).toEqual([]);
    });

    it('routes structured stdout formatter output via sendStructured and keeps raw stdout', async () => {
      const captured: StructuredMessage[] = [];
      const adapter: LoggerAdapter = {
        log: () => {},
        error: () => {},
        warn: () => {},
        writeStdout: () => {},
        writeStderr: () => {},
        debugLog: () => {},
        sendStructured: (message: StructuredMessage) => {
          captured.push(message);
        },
      };

      await runWithLogger(adapter, async () => {
        const result = await spawnAndLogOutput(['echo', 'hello'], {
          formatStdout: () => ({
            type: 'workflow_progress',
            timestamp: '2026-02-08T00:00:00.000Z',
            message: 'formatted',
          }),
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('hello');
      });

      expect(captured).toEqual([
        {
          type: 'workflow_progress',
          timestamp: '2026-02-08T00:00:00.000Z',
          message: 'formatted',
        },
      ]);
    });

    it('should execute commands and capture output', async () => {
      const result = await spawnAndLogOutput(['echo', 'hello world']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello world');
      expect(result.stderr).toBe('');
    });

    it('should handle stdin input', async () => {
      const result = await spawnAndLogOutput(['cat'], {
        stdin: 'test input',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('test input');
    });

    it('works without stdin option for processes that do not read stdin', async () => {
      const result = await spawnAndLogOutput(['sh', '-c', 'echo no-stdin-needed'], {
        quiet: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('no-stdin-needed');
      expect(result.stderr).toBe('');
    });

    it('should handle cwd option', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-spawn-'));

      try {
        const result = await spawnAndLogOutput(['pwd'], {
          cwd: tempDir,
        });

        expect(result.exitCode).toBe(0);
        expect(await fs.realpath(result.stdout.trim())).toBe(await fs.realpath(tempDir));
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should format stdout when formatStdout is provided', async () => {
      const result = await spawnAndLogOutput(['echo', 'hello'], {
        formatStdout: (output) => output.toUpperCase(),
        quiet: true, // Suppress actual output during test
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('HELLO');
    });

    it('should format stderr when formatStderr is provided', async () => {
      // Use a command that outputs to stderr
      const result = await spawnAndLogOutput(['sh', '-c', 'echo "error" >&2'], {
        formatStderr: (output) => `[ERROR] ${output}`,
        quiet: true, // Suppress actual output during test
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr.trim()).toBe('[ERROR] error');
    });

    it('should handle non-zero exit codes', async () => {
      const result = await spawnAndLogOutput(['sh', '-c', 'exit 1']);

      expect(result.exitCode).toBe(1);
    });

    it('terminates long-silent processes after inactivity timeout', async () => {
      const start = Date.now();
      const result = await spawnAndLogOutput(['node', '-e', 'setTimeout(() => {}, 5000)'], {
        inactivityTimeoutMs: 50,
        quiet: true,
      });

      const duration = Date.now() - start;

      expect(result.killedByInactivity).toBeTrue();
      // Either signal or conventional exit code after SIGTERM
      expect(
        result.signal === 'SIGTERM' || result.exitCode === 143 || result.exitCode === 137
      ).toBeTrue();
      expect(duration).toBeLessThan(2000);
    });

    it('pauses inactivity timer on SIGTSTP and resumes on SIGCONT', async () => {
      // This test verifies that the inactivity timer is properly paused when the process
      // is suspended and resumed when it continues
      const script = `
        // Write initial output
        process.stdout.write('start\\n');
        // Sleep for a bit to let the test send signals
        setTimeout(() => {
          process.stdout.write('end\\n');
        }, 200);
      `;

      const promise = spawnAndLogOutput(['node', '-e', script], {
        inactivityTimeoutMs: 500,
        quiet: true,
        _skipSelfSuspend: true,
      });

      // Give it a moment to start and produce initial output
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Simulate suspension
      process.emit('SIGTSTP' as any);

      // Wait longer than the inactivity timeout would normally allow
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Resume
      process.emit('SIGCONT' as any);

      // Wait for the process to complete
      const result = await promise;

      // The process should have completed successfully, not been killed by inactivity
      expect(result.killedByInactivity).toBeFalse();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('start');
      expect(result.stdout).toContain('end');
    });
  });

  describe('spawnWithStreamingIO', () => {
    it('returns writable stdin and resolves result when stdin is closed', async () => {
      const proc = await spawnWithStreamingIO(['cat'], { quiet: true });

      proc.stdin.write('streamed input');
      await proc.stdin.end();

      const result = await proc.result;
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('streamed input');
      expect(result.stderr).toBe('');
    });

    it('supports inactivity timeout while streaming', async () => {
      const start = Date.now();
      const proc = await spawnWithStreamingIO(['node', '-e', 'setTimeout(() => {}, 5000)'], {
        inactivityTimeoutMs: 50,
        quiet: true,
      });

      await proc.stdin.end();
      const result = await proc.result;
      const duration = Date.now() - start;

      expect(result.killedByInactivity).toBeTrue();
      expect(
        result.signal === 'SIGTERM' || result.exitCode === 143 || result.exitCode === 137
      ).toBeTrue();
      expect(duration).toBeLessThan(2000);
    });
  });

  describe('createLineSplitter', () => {
    it('should split complete lines correctly', () => {
      const splitter = createLineSplitter();

      const result1 = splitter('line1\nline2\n');
      expect(result1).toEqual(['line1', 'line2']);

      const result2 = splitter('line3\n');
      expect(result2).toEqual(['line3']);
    });

    it('should handle partial lines', () => {
      const splitter = createLineSplitter();

      // First chunk with partial line
      const result1 = splitter('partial');
      expect(result1).toEqual([]);

      // Complete the line
      const result2 = splitter(' line\nfull line\n');
      expect(result2).toEqual(['partial line', 'full line']);
    });

    it('should handle empty input', () => {
      const splitter = createLineSplitter();

      const result = splitter('');
      expect(result).toEqual([]);
    });

    it('should preserve fragments across calls', () => {
      const splitter = createLineSplitter();

      splitter('first');
      splitter(' part');
      const result = splitter(' complete\n');

      expect(result).toEqual(['first part complete']);
    });
  });
});
