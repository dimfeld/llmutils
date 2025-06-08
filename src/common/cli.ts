/**
 * Parses a command string into an array of arguments, handling quotes and escapes.
 * Mimics shell argument parsing behavior.
 * @param commandString The command string to parse.
 * @returns An array of parsed arguments.
 */
export function parseCliArgsFromString(commandString: string): string[] {
  const args: string[] = [];
  let i = 0;
  const n = commandString.length;

  while (i < n) {
    // Skip leading whitespace
    while (i < n && /\s/.test(commandString[i])) {
      i++;
    }
    if (i === n) break;

    const start = i;
    let currentArg = '';
    const quoteChar = commandString[i];

    if (quoteChar === '"' || quoteChar === "'") {
      i++;
      while (i < n) {
        if (commandString[i] === '\\' && i + 1 < n) {
          // Handle escaped characters: only escape the quote char itself or a backslash
          if (commandString[i + 1] === quoteChar || commandString[i + 1] === '\\') {
            currentArg += commandString[i + 1];
            i += 2;
          } else {
            // Keep other escaped characters as is (e.g., \n)
            currentArg += commandString[i] + commandString[i + 1];
            i += 2;
          }
        } else if (commandString[i] === quoteChar) {
          i++;
          break;
        } else {
          currentArg += commandString[i];
          i++;
        }
      }
    } else {
      // Unquoted argument
      while (i < n && !/\s/.test(commandString[i])) {
        // Note: Unquoted arguments don't typically handle escapes in the same way shell does,
        // but we'll treat backslash literally here unless followed by space (which terminates).
        // This simple parser doesn't aim for full shell compatibility.
        currentArg += commandString[i];
        i++;
      }
    }
    args.push(currentArg);
  }

  return args;
}

export function needArrayOrUndefined<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  return [value];
}
