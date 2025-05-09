import { describe, it, expect, spyOn } from 'bun:test';
import { prepareCommand, type OutputFormat } from './command';
import * as CommandModule from './command';
import { detectPackageManager } from './command';

describe('prepareCommand', () => {
  // Test Case 1: Simple command (not an npm script)
  it('should return the command as is if package.json does not exist', async () => {
    const mockFile = {
      exists: async () => false,
      json: async () => ({}),
      // Add other BunFile properties/methods if needed for type completeness,
      // but for this test, only `exists` is called.
    };
    const bunFileSpy = spyOn(Bun, 'file').mockImplementation((path: string) => {
      if (path === './package.json') {
        return mockFile as any;
      }
      throw new Error(`Unexpected Bun.file call with path: ${path}`);
    });

    const result = await prepareCommand('ls', ['-la'], 'auto');
    expect(result).toEqual({ finalCommand: 'ls', finalArgs: ['-la'] });

    bunFileSpy.mockRestore();
  });

  it('should return the command as is if it is not in package.json scripts', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { 'another-script': 'echo hello' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockImplementation((path: string) => {
      if (path === './package.json') {
        return mockFile as any;
      }
      throw new Error(`Unexpected Bun.file call with path: ${path}`);
    });

    const result = await prepareCommand('ls', ['-la'], 'auto');
    expect(result).toEqual({ finalCommand: 'ls', finalArgs: ['-la'] });

    bunFileSpy.mockRestore();
  });

  // Test Case 2: NPM script detection (defaulting to npm)
  it('should use npm for a known script when package manager is npm', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { test: 'some-test-runner' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager').mockResolvedValue('npm');

    const result = await prepareCommand('test', ['--watch'], 'auto');
    expect(result).toEqual({
      finalCommand: 'npm',
      finalArgs: ['run', 'test', '--', 'some-test-runner', '--watch'],
    });
    expect(dpmSpy).toHaveBeenCalledTimes(1);

    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  // Test Case 3: Bun script detection
  it('should use bun for a known script when package manager is bun', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { dev: 'vite' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager').mockResolvedValue('bun');

    const result = await prepareCommand('dev', [], 'auto');
    expect(result).toEqual({
      finalCommand: 'bun',
      finalArgs: ['run', 'dev', '--', 'vite'],
    });
    expect(dpmSpy).toHaveBeenCalledTimes(1);

    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  // Test Case 4: Yarn script detection
  it('should use yarn for a known script when package manager is yarn', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { build: 'tsc' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager').mockResolvedValue('yarn');

    const result = await prepareCommand('build', ['--project', 'tsconfig.json'], 'auto');
    expect(result).toEqual({
      finalCommand: 'yarn',
      finalArgs: ['run', 'build', '--', 'tsc', '--project', 'tsconfig.json'],
    });
    expect(dpmSpy).toHaveBeenCalledTimes(1);

    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  // Test Case 5: Command with no args that is an npm script
  it('should handle npm script with no additional args', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { lint: 'eslint .' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager').mockResolvedValue('npm');

    const result = await prepareCommand('lint', [], 'auto');
    expect(result).toEqual({
      finalCommand: 'npm',
      finalArgs: ['run', 'lint', '--', 'eslint', '.'],
    });
    expect(dpmSpy).toHaveBeenCalledTimes(1);

    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  // Additional test cases for robustness
  it('should handle missing scripts object in package.json', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ name: 'my-package' }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager');

    const result = await prepareCommand('test', [], 'auto');
    expect(result).toEqual({ finalCommand: 'test', finalArgs: [] });
    expect(dpmSpy).not.toHaveBeenCalled();

    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  it('should handle null scripts object in package.json', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: null }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager');

    const result = await prepareCommand('test', [], 'auto');
    expect(result).toEqual({ finalCommand: 'test', finalArgs: [] });
    expect(dpmSpy).not.toHaveBeenCalled();

    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  it('should handle unparseable package.json gracefully and warn', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => {
        throw new Error('Invalid JSON');
      },
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager');

    const result = await prepareCommand('test', [], 'auto');
    expect(result).toEqual({ finalCommand: 'test', finalArgs: [] });
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[rmfix] Warning: Could not parse ./package.json. Proceeding as if it's not an npm script. Error: Invalid JSON"
      )
    );
    expect(dpmSpy).not.toHaveBeenCalled();

    bunFileSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  // --- Tests for Test Runner Detection and Reporter Injection ---

  // Jest - Direct Command
  it('should inject --json for direct jest command if no reporter specified', async () => {
    const result = await prepareCommand('jest', ['--ci'], 'auto');
    expect(result).toEqual({ finalCommand: 'jest', finalArgs: ['--json', '--ci'] });
  });

  it('should not inject --json for direct jest command if --json is already present', async () => {
    const result = await prepareCommand('jest', ['--json', '--ci'], 'auto');
    expect(result).toEqual({ finalCommand: 'jest', finalArgs: ['--json', '--ci'] });
  });

  it('should inject --json for direct jest command even if --outputFile is present (prioritizing stdout)', async () => {
    const result = await prepareCommand('jest', ['--outputFile=results.json', '--ci'], 'auto');
    expect(result).toEqual({
      finalCommand: 'jest',
      finalArgs: ['--json', '--outputFile=results.json', '--ci'],
    });
  });

  // Vitest - Direct Command
  it('should inject --reporter=json for direct vitest command if no reporter specified', async () => {
    const result = await prepareCommand('vitest', ['--run'], 'auto');
    expect(result).toEqual({ finalCommand: 'vitest', finalArgs: ['--reporter=json', '--run'] });
  });

  it('should not inject --reporter=json for direct vitest command if --reporter=json is present', async () => {
    const result = await prepareCommand('vitest', ['--reporter=json', '--run'], 'auto');
    expect(result).toEqual({ finalCommand: 'vitest', finalArgs: ['--reporter=json', '--run'] });
  });

  it('should not inject --reporter=json for direct vitest command if --reporter json is present', async () => {
    const result = await prepareCommand('vitest', ['--reporter', 'json', '--run'], 'auto');
    expect(result).toEqual({ finalCommand: 'vitest', finalArgs: ['--reporter', 'json', '--run'] });
  });

  // NPM Scripts with Test Runners
  it('should inject --json into npm script args for jest runner', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { test: 'jest --coverage' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager').mockResolvedValue('npm');

    const result = await prepareCommand('test', ['--watch'], 'auto');
    expect(result).toEqual({
      finalCommand: 'npm',
      finalArgs: ['run', 'test', '--', 'jest', '--json', '--coverage', '--watch'],
    });

    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  it('should inject --reporter=json into npm script args for vitest runner', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { test: 'vitest --run' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager').mockResolvedValue('bun');

    const result = await prepareCommand('test', ['--changed'], 'auto');
    expect(result).toEqual({
      finalCommand: 'bun',
      finalArgs: ['run', 'test', '--', 'vitest', '--reporter=json', '--run', '--changed'],
    });

    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  it('should not inject if npm script for jest already has --json', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { test: 'jest --json --ci' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager').mockResolvedValue('npm');

    const result = await prepareCommand('test', [], 'auto');
    expect(result).toEqual({
      finalCommand: 'npm',
      finalArgs: ['run', 'test', '--', 'jest', '--json', '--ci'],
    });

    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  // Commands via npx/pnpm/yarn dlx
  it('should inject --json for `npx jest` command', async () => {
    const result = await prepareCommand('npx', ['jest', '--watchAll'], 'auto');
    expect(result).toEqual({ finalCommand: 'npx', finalArgs: ['jest', '--json', '--watchAll'] });
  });

  it('should inject --reporter=json for `pnpm vitest` command', async () => {
    // Assuming 'pnpm' behaves like 'npx' for this detection logic
    const result = await prepareCommand('pnpm', ['vitest', 'run', '--threads=false'], 'auto');
    expect(result).toEqual({
      finalCommand: 'pnpm',
      finalArgs: ['vitest', '--reporter=json', 'run', '--threads=false'],
    });
  });

  it('should inject --reporter=json for `yarn dlx vitest` command', async () => {
    const result = await prepareCommand('yarn', ['dlx', 'vitest', '--ui'], 'auto');
    expect(result).toEqual({
      finalCommand: 'yarn',
      finalArgs: ['dlx', 'vitest', '--reporter=json', '--ui'],
    });
  });

  it('should not inject for `npx jest --json` command', async () => {
    const result = await prepareCommand('npx', ['jest', '--json', '--watchAll'], 'auto');
    expect(result).toEqual({ finalCommand: 'npx', finalArgs: ['jest', '--json', '--watchAll'] });
  });

  it('should handle npm script that runs npx jest', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { test: 'npx jest --ci' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager').mockResolvedValue('npm');

    const result = await prepareCommand('test', ['--maxWorkers=2'], 'auto');
    expect(result).toEqual({
      finalCommand: 'npm',
      finalArgs: ['run', 'test', '--', 'npx', 'jest', '--json', '--ci', '--maxWorkers=2'],
    });

    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  it('should handle path-like commands for jest', async () => {
    const result = await prepareCommand('./node_modules/.bin/jest', ['--ci'], 'auto');
    expect(result).toEqual({
      finalCommand: './node_modules/.bin/jest',
      finalArgs: ['--json', '--ci'],
    });
  });

  it('should handle path-like commands for vitest in an npm script', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { test: 'node_modules/.bin/vitest --run' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager').mockResolvedValue('npm');

    const result = await prepareCommand('test', [], 'auto');
    expect(result).toEqual({
      finalCommand: 'npm',
      finalArgs: ['run', 'test', '--', 'node_modules/.bin/vitest', '--reporter=json', '--run'],
    });
    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  // Tests for currentFormat preventing injection
  it('should NOT inject --json for direct jest if currentFormat is "tap"', async () => {
    const result = await prepareCommand('jest', ['--ci'], 'tap');
    expect(result).toEqual({ finalCommand: 'jest', finalArgs: ['--ci'] });
  });

  it('should NOT inject --reporter=json for direct vitest if currentFormat is "text"', async () => {
    const result = await prepareCommand('vitest', ['--run'], 'text');
    expect(result).toEqual({ finalCommand: 'vitest', finalArgs: ['--run'] });
  });

  it('should NOT inject --json into npm script for jest if currentFormat is "tap"', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { test: 'jest --coverage' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager').mockResolvedValue('npm');

    const result = await prepareCommand('test', ['--watch'], 'tap');
    expect(result).toEqual({
      finalCommand: 'npm',
      finalArgs: ['run', 'test', '--', 'jest', '--coverage', '--watch'],
    });
    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });
});
