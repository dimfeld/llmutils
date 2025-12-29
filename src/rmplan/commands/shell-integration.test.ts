import { describe, test, expect } from 'bun:test';

describe('shell-integration command', () => {
  test('generates zsh function by default', async () => {
    const { generateShellFunction } = await import('./shell-integration.js');

    const output = generateShellFunction('zsh');

    expect(output).toContain('# Zsh function');
    expect(output).toContain('~/.zshrc');
    expect(output).toContain('rmplan_ws()');
    expect(output).toContain('rmplan workspace list --format tsv --no-header');
    expect(output).toContain('fzf');
    expect(output).toContain('--delimiter');
    expect(output).toContain('--with-nth');
    expect(output).toContain('--preview');
    expect(output).toContain('cd "$workspace_path"');
  });

  test('generates bash function when shell is bash', async () => {
    const { generateShellFunction } = await import('./shell-integration.js');

    const output = generateShellFunction('bash');

    expect(output).toContain('# Bash function');
    expect(output).toContain('~/.bashrc');
    expect(output).toContain('rmplan_ws()');
  });

  test('includes fzf check in generated function', async () => {
    const { generateShellFunction } = await import('./shell-integration.js');

    const output = generateShellFunction('zsh');

    expect(output).toContain('command -v fzf');
    expect(output).toContain('fzf is not installed');
    expect(output).toContain('return 1');
  });

  test('includes query argument support', async () => {
    const { generateShellFunction } = await import('./shell-integration.js');

    const output = generateShellFunction('zsh');

    expect(output).toContain('rmplan_ws <query>');
    expect(output).toContain('--query "$1"');
  });

  test('handles cancellation exit code 130', async () => {
    const { generateShellFunction } = await import('./shell-integration.js');

    const output = generateShellFunction('zsh');

    expect(output).toContain('exit_code=$?');
    expect(output).toContain('$exit_code -eq 130');
    expect(output).toContain('return 0');
  });

  test('includes preview with workspace info', async () => {
    const { generateShellFunction } = await import('./shell-integration.js');

    const output = generateShellFunction('zsh');

    expect(output).toContain("--preview 'echo");
    expect(output).toContain('Path:');
    expect(output).toContain('Description:');
    expect(output).toContain('Branch:');
  });

  test('handleShellIntegrationCommand outputs function code', async () => {
    const capturedOutput: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: any[]) => {
      capturedOutput.push(args.map(String).join(' '));
    };

    try {
      const { handleShellIntegrationCommand } = await import('./shell-integration.js');

      handleShellIntegrationCommand({ shell: 'bash' });

      const output = capturedOutput.join('\n');
      expect(output).toContain('# Bash function');
      expect(output).toContain('rmplan_ws()');
    } finally {
      console.log = originalConsoleLog;
    }
  });

  test('handleShellIntegrationCommand defaults to zsh', async () => {
    const capturedOutput: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: any[]) => {
      capturedOutput.push(args.map(String).join(' '));
    };

    try {
      const { handleShellIntegrationCommand } = await import('./shell-integration.js');

      handleShellIntegrationCommand({});

      const output = capturedOutput.join('\n');
      expect(output).toContain('# Zsh function');
    } finally {
      console.log = originalConsoleLog;
    }
  });
});
