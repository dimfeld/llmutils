import { describe, it, expect, spyOn } from 'bun:test';
import { prepareCommand } from './command';
import * as CommandModule from './command';

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

    const result = await prepareCommand('ls', ['-la']);
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

    const result = await prepareCommand('ls', ['-la']);
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

    const result = await prepareCommand('test', ['--watch']);
    expect(result).toEqual({
      finalCommand: 'npm',
      finalArgs: ['run', 'test', '--watch'],
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

    const result = await prepareCommand('dev', []);
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

    const result = await prepareCommand('build', ['--project', 'tsconfig.json']);
    expect(result).toEqual({
      finalCommand: 'yarn',
      finalArgs: ['run', 'build', '--project', 'tsconfig.json'],
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

    const result = await prepareCommand('lint', []);
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

    const result = await prepareCommand('test', []);
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

    const result = await prepareCommand('test', []);
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

    const result = await prepareCommand('test', []);
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
});
