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
