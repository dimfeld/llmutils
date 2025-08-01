import { describe, it, expect, spyOn } from 'bun:test';
import { prepareCommand, type OutputFormat } from './command';
import * as CommandModule from './command';
import { detectPackageManager } from './command';
import * as logging from '../logging.js';

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
      finalArgs: ['run', 'test', '--', '--watch'],
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
      finalArgs: ['run', 'dev'],
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
      finalArgs: ['run', 'build', '--', '--project', 'tsconfig.json'],
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
      finalArgs: ['run', 'lint'],
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
    const loggingWarnSpy = spyOn(logging, 'warn').mockImplementation(() => {});
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager');

    const result = await prepareCommand('test', [], 'auto');
    expect(result).toEqual({ finalCommand: 'test', finalArgs: [] });
    expect(dpmSpy).not.toHaveBeenCalled();

    bunFileSpy.mockRestore();
    loggingWarnSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  // --- Tests for Test Runner Detection and Reporter Injection ---

  // Jest - Direct Command
  it('should inject --json for direct jest command if no reporter specified', async () => {
    const result = await prepareCommand('jest', ['--ci'], 'auto');
    expect(result).toEqual({ finalCommand: 'jest', finalArgs: ['--ci', '--json'] });
  });

  it('should inject --json for direct jest command if format is json', async () => {
    const result = await prepareCommand('jest', ['--ci'], 'json');
    expect(result).toEqual({ finalCommand: 'jest', finalArgs: ['--ci', '--json'] });
  });

  it('should not inject for direct jest if --reporters=some-json.js is present', async () => {
    const result = await prepareCommand('jest', ['--reporters=some-json.js', '--ci'], 'auto');
    expect(result).toEqual({
      finalCommand: 'jest',
      finalArgs: ['--reporters=some-json.js', '--ci'],
    });
  });

  it('should not inject for direct jest if --reporters ... some-json.js is present', async () => {
    const result = await prepareCommand('jest', ['--reporters', 'some-json.js', '--ci'], 'auto');
    expect(result).toEqual({
      finalCommand: 'jest',
      finalArgs: ['--reporters', 'some-json.js', '--ci'],
    });
  });
  it('should not inject --json for direct jest command if --json is already present', async () => {
    const result = await prepareCommand('jest', ['--json', '--ci'], 'auto');
    expect(result).toEqual({ finalCommand: 'jest', finalArgs: ['--json', '--ci'] });
  });

  it('should inject --json for direct jest command even if --outputFile is present (prioritizing stdout)', async () => {
    const result = await prepareCommand('jest', ['--outputFile=results.json', '--ci'], 'auto');
    expect(result).toEqual({
      finalCommand: 'jest',
      finalArgs: ['--outputFile=results.json', '--ci', '--json'],
    });
  });

  // Vitest - Direct Command
  it('should inject --reporter=json for direct vitest command if no reporter specified', async () => {
    const result = await prepareCommand('vitest', ['--run'], 'auto');
    expect(result).toEqual({ finalCommand: 'vitest', finalArgs: ['--run', '--reporter=json'] });
  });

  it('should inject --reporter=json for direct vitest command if format is json', async () => {
    const result = await prepareCommand('vitest', ['--run'], 'json');
    expect(result).toEqual({ finalCommand: 'vitest', finalArgs: ['--run', '--reporter=json'] });
  });

  it('should not inject --reporter=json for direct vitest command if --reporter=json is present', async () => {
    const result = await prepareCommand('vitest', ['--reporter=json', '--run'], 'auto');
    expect(result).toEqual({ finalCommand: 'vitest', finalArgs: ['--reporter=json', '--run'] });
  });

  it('should not inject --reporter=json for direct vitest command if --reporter json is present', async () => {
    const result = await prepareCommand('vitest', ['--reporter', 'json', '--run'], 'auto');
    expect(result).toEqual({ finalCommand: 'vitest', finalArgs: ['--reporter', 'json', '--run'] });
  });

  it('should not inject for direct vitest if --reporter=custom-json.js is present', async () => {
    const result = await prepareCommand('vitest', ['--reporter=custom-json.js', '--run'], 'auto');
    expect(result).toEqual({
      finalCommand: 'vitest',
      finalArgs: ['--reporter=custom-json.js', '--run'],
    });
  });

  it('should not inject for direct vitest if --reporter custom-json.js is present', async () => {
    const result = await prepareCommand(
      'vitest',
      ['--reporter', 'custom-json.js', '--run'],
      'auto'
    );
    expect(result).toEqual({
      finalCommand: 'vitest',
      finalArgs: ['--reporter', 'custom-json.js', '--run'],
    });
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
      finalArgs: ['run', 'test', '--', '--watch', '--json'],
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
      finalArgs: ['run', 'test', '--', '--changed', '--reporter=json'],
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
      finalArgs: ['run', 'test'],
    });

    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  it('should not inject if npm script for jest already has --reporters=some-json.js', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { test: 'jest --reporters=some-json.js --ci' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager').mockResolvedValue('npm');

    const result = await prepareCommand('test', [], 'auto');
    expect(result).toEqual({
      finalCommand: 'npm',
      finalArgs: ['run', 'test'],
    });
    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  it('should not inject if npm script for vitest already has --reporter=custom-json.js', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { test: 'vitest --reporter=custom-json.js --run' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager').mockResolvedValue('npm');

    const result = await prepareCommand('test', [], 'auto');
    expect(result).toEqual({
      finalCommand: 'npm',
      finalArgs: ['run', 'test'],
    });
    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  it('should not inject if user args for npm jest script provide --json', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { test: 'jest --ci' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager').mockResolvedValue('npm');

    const result = await prepareCommand('test', ['--json'], 'auto');
    expect(result).toEqual({
      finalCommand: 'npm',
      finalArgs: ['run', 'test', '--', '--json'],
    });
    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  it('should not inject if user args for npm vitest script provide --reporter=json', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { test: 'vitest --run' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager').mockResolvedValue('npm');

    const result = await prepareCommand('test', ['--reporter=json'], 'auto');
    expect(result).toEqual({
      finalCommand: 'npm',
      finalArgs: ['run', 'test', '--', '--reporter=json'],
    });
    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  // Commands via npx/pnpm/yarn dlx
  it('should inject --json for `npx jest` command', async () => {
    const result = await prepareCommand('npx', ['jest', '--watchAll'], 'auto');
    expect(result).toEqual({ finalCommand: 'npx', finalArgs: ['jest', '--watchAll', '--json'] });
  });

  it('should inject --reporter=json for `pnpm vitest` command', async () => {
    // Assuming 'pnpm' behaves like 'npx' for this detection logic
    const result = await prepareCommand('pnpm', ['vitest', 'run', '--threads=false'], 'auto');
    expect(result).toEqual({
      finalCommand: 'pnpm',
      finalArgs: ['vitest', 'run', '--threads=false', '--reporter=json'],
    });
  });

  it('should inject --reporter=json for `yarn dlx vitest` command', async () => {
    const result = await prepareCommand('yarn', ['dlx', 'vitest', '--ui'], 'auto');
    expect(result).toEqual({
      finalCommand: 'yarn',
      finalArgs: ['dlx', 'vitest', '--ui', '--reporter=json'],
    });
  });

  it('should not inject for `npx jest --json` command', async () => {
    const result = await prepareCommand('npx', ['jest', '--json', '--watchAll'], 'auto');
    expect(result).toEqual({ finalCommand: 'npx', finalArgs: ['jest', '--json', '--watchAll'] });
  });

  it('should not inject for `npx jest --reporters=custom-json.js` command', async () => {
    const result = await prepareCommand(
      'npx',
      ['jest', '--reporters=custom-json.js', '--watchAll'],
      'auto'
    );
    expect(result).toEqual({
      finalCommand: 'npx',
      finalArgs: ['jest', '--reporters=custom-json.js', '--watchAll'],
    });
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
      finalArgs: ['run', 'test', '--', '--maxWorkers=2', '--json'],
    });

    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  it('should handle path-like commands for jest', async () => {
    const result = await prepareCommand('./node_modules/.bin/jest', ['--ci'], 'auto');
    expect(result).toEqual({
      finalCommand: './node_modules/.bin/jest',
      finalArgs: ['--ci', '--json'],
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
      finalArgs: ['run', 'test', '--', '--reporter=json'],
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
      finalArgs: ['run', 'test', '--', '--watch'],
    });
    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });

  it('should NOT inject --reporter=json into npm script for vitest if currentFormat is "tap"', async () => {
    const mockFile = {
      exists: async () => true,
      json: async () => ({ scripts: { test: 'vitest --coverage' } }),
    };
    const bunFileSpy = spyOn(Bun, 'file').mockReturnValue(mockFile as any);
    const dpmSpy = spyOn(CommandModule, 'detectPackageManager').mockResolvedValue('npm');

    const result = await prepareCommand('test', ['--watch'], 'tap');
    expect(result).toEqual({
      finalCommand: 'npm',
      finalArgs: ['run', 'test', '--', '--watch'],
    });
    bunFileSpy.mockRestore();
    dpmSpy.mockRestore();
  });
});
