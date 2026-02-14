import { describe, test, expect } from 'bun:test';
import { Command } from 'commander';

describe('Commander negated options mapping', () => {
  test('--no-summary sets options.summary === false', () => {
    const cmd = new Command();
    cmd
      .option('--no-summary', 'Disable execution summary display at the end')
      .allowUnknownOption(true);

    cmd.parse(['--no-summary'], { from: 'user' });
    const opts = cmd.opts();
    expect(opts.summary).toBe(false);
  });

  test('--no-log sets options.log === false', () => {
    const cmd = new Command();
    cmd.option('--no-log', 'Do not log to file').allowUnknownOption(true);

    cmd.parse(['--no-log'], { from: 'user' });
    const opts = cmd.opts();
    expect(opts.log).toBe(false);
  });

  test('--no-terminal-input sets options.terminalInput === false', () => {
    const cmd = new Command();
    cmd.option('--no-terminal-input', 'Disable terminal input').allowUnknownOption(true);

    cmd.parse(['--no-terminal-input'], { from: 'user' });
    const opts = cmd.opts();
    expect(opts.terminalInput).toBe(false);
  });
});
