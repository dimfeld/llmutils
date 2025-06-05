import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { logSpawn, spawnAndLogOutput, setDebug, setQuiet, debug, quiet, createLineSplitter } from './process';

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
          stdout: 'pipe'
        });
        
        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout as ReadableStream).text();
        
        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe(tempDir);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should modify stdio options when quiet is enabled', async () => {
      setQuiet(true);
      
      const proc = logSpawn(['echo', 'test'], {
        stdout: 'inherit', // Should be changed to 'ignore' by logSpawn
        stderr: 'inherit'  // Should be changed to 'ignore' by logSpawn
      });
      
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    });
  });

  describe('spawnAndLogOutput', () => {
    it('should execute commands and capture output', async () => {
      const result = await spawnAndLogOutput(['echo', 'hello world']);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello world');
      expect(result.stderr).toBe('');
    });

    it('should handle stdin input', async () => {
      const result = await spawnAndLogOutput(['cat'], {
        stdin: 'test input'
      });
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('test input');
    });

    it('should handle cwd option', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-spawn-'));
      
      try {
        const result = await spawnAndLogOutput(['pwd'], {
          cwd: tempDir
        });
        
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(tempDir);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should format stdout when formatStdout is provided', async () => {
      const result = await spawnAndLogOutput(['echo', 'hello'], {
        formatStdout: (output) => output.toUpperCase(),
        quiet: true // Suppress actual output during test
      });
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('HELLO');
    });

    it('should format stderr when formatStderr is provided', async () => {
      // Use a command that outputs to stderr
      const result = await spawnAndLogOutput(['sh', '-c', 'echo "error" >&2'], {
        formatStderr: (output) => `[ERROR] ${output}`,
        quiet: true // Suppress actual output during test
      });
      
      expect(result.exitCode).toBe(0);
      expect(result.stderr.trim()).toBe('[ERROR] error');
    });

    it('should handle non-zero exit codes', async () => {
      const result = await spawnAndLogOutput(['sh', '-c', 'exit 1']);
      
      expect(result.exitCode).toBe(1);
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