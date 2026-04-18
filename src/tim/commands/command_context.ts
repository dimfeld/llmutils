export function getRootCommandOptions(command: any): Record<string, unknown> {
  let cursor = command;
  while (cursor?.parent) {
    cursor = cursor.parent;
  }

  return typeof cursor?.opts === 'function' ? (cursor.opts() as Record<string, unknown>) : {};
}
