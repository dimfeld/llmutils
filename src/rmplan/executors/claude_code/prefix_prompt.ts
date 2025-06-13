import { createPrompt, useState, useKeypress, isEnterKey } from '@inquirer/core';
import chalk from 'chalk';

interface PrefixPromptConfig {
  message: string;
  command: string;
}

export const prefixPrompt = createPrompt<string, PrefixPromptConfig>((config, done) => {
  const words = config.command.split(/\s+/).filter((word) => word.length > 0);
  const [selectedWordIndex, setSelectedWordIndex] = useState(words.length - 1);

  useKeypress((key) => {
    if (key.name === 'left' && selectedWordIndex > 0) {
      setSelectedWordIndex(selectedWordIndex - 1);
    } else if (key.name === 'right' && selectedWordIndex < words.length - 1) {
      setSelectedWordIndex(selectedWordIndex + 1);
    } else if (key.name === 'a') {
      setSelectedWordIndex(words.length - 1);
    } else if (isEnterKey(key)) {
      const selectedPrefix = words.slice(0, selectedWordIndex + 1).join(' ');
      done(selectedPrefix);
    }
  });

  const selectedPrefix = words.slice(0, selectedWordIndex + 1).join(' ');
  const remainingCommand = words.slice(selectedWordIndex + 1).join(' ');

  const commandDisplay = remainingCommand
    ? chalk.green(selectedPrefix) + ' ' + chalk.gray(remainingCommand)
    : chalk.green(selectedPrefix);

  return [
    config.message,
    '',
    commandDisplay,
    '',
    chalk.dim('Use ← → arrow keys to select prefix, "a" to select all, Enter to confirm'),
  ].join('\n');
});
