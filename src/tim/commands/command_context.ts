export interface CommandContext {
  config?: string;
  debug?: boolean;
}

export function getRootCommandOptions(command: any): CommandContext {
  let cursor = command;
  while (cursor?.parent) {
    cursor = cursor.parent;
  }

  return typeof cursor?.opts === 'function' ? (cursor.opts() as CommandContext) : {};
}
