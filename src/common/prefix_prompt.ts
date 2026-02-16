import { createPrompt, useState, useKeypress, isEnterKey } from '@inquirer/core';
import chalk from 'chalk';

interface PrefixPromptConfig {
  message: string;
  command: string;
}

export interface PrefixPromptResult {
  exact: boolean;
  command: string;
}

export function extractCommandAfterCd(command: string): string {
  // Match "cd <dir> && <command>" and keep only the command segment.
  const cdPattern = /^cd\s+(?:"[^"]+"|'[^']+'|[^\s]+)\s*&&\s*(.+)$/;
  const match = command.match(cdPattern);
  return match ? match[1].trim() : command;
}

const prefixPromptInternal = createPrompt<PrefixPromptResult, PrefixPromptConfig>(
  (config, done) => {
    const actualCommand = extractCommandAfterCd(config.command);
    const words = actualCommand.split(/\s+/).filter((word) => word.length > 0);
    const [selectedWordIndex, setSelectedWordIndex] = useState(words.length - 1);

    useKeypress((key) => {
      if (key.name === 'left' && selectedWordIndex > 0) {
        setSelectedWordIndex(selectedWordIndex - 1);
      } else if (key.name === 'right' && selectedWordIndex < words.length - 1) {
        setSelectedWordIndex(selectedWordIndex + 1);
      } else if (key.name === 'a') {
        if (selectedWordIndex === words.length - 1) {
          setSelectedWordIndex(0);
        } else {
          setSelectedWordIndex(words.length - 1);
        }
      } else if (key.name === 'e') {
        done({ exact: true, command: actualCommand });
      } else if (isEnterKey(key)) {
        const selectedPrefix = words.slice(0, selectedWordIndex + 1).join(' ');
        done({ exact: false, command: selectedPrefix });
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
      chalk.dim(
        'Use <- -> arrows to select prefix, "a" to select all, Enter to confirm\nor "e" to select the exact command instead of a prefix'
      ),
    ].join('\n');
  }
);

export async function runPrefixPrompt(
  config: PrefixPromptConfig,
  options?: { signal?: AbortSignal }
): Promise<PrefixPromptResult> {
  return await prefixPromptInternal(config, options);
}
