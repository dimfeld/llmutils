import * as YAML from 'yaml';

// Interface for YAML parsing error
interface YamlError {
  message: string;
  code?: string;
  source?: {
    range: { start: number; end: number };
    pos: { line: number; col: number };
  };
}

// Function to fix common YAML parsing issues
export function fixYaml(inputYaml: string, maxAttempts: number = 5) {
  let currentYaml: string = inputYaml;
  let attempt: number = 0;
  let lastErrorLine: number | null = null;

  while (attempt < maxAttempts) {
    try {
      // Attempt to parse the YAML
      let parsedYaml = YAML.parse(currentYaml);
      return parsedYaml;
    } catch (error: unknown) {
      if (attempt === maxAttempts - 1) {
        throw error;
      }
      attempt++;

      const yamlError = error as any;

      // Extract line number from error message if not in source
      let lineNumber: number | null = null;
      let colNumber: number | null = null;

      if (yamlError.source?.pos) {
        lineNumber = yamlError.source.pos.line + 1;
        colNumber = yamlError.source.pos.col;
      } else if (yamlError.linePos) {
        // Some YAML errors have linePos property
        lineNumber = yamlError.linePos[0].line;
        colNumber = yamlError.linePos[0].col;
      } else {
        // Try to extract from error message
        const lineMatch = yamlError.message.match(/at line (\d+), column (\d+)/);
        if (lineMatch) {
          lineNumber = parseInt(lineMatch[1]);
          colNumber = parseInt(lineMatch[2]);
        } else if (yamlError.message.includes('Unresolved alias')) {
          // For unresolved alias errors, try to find the line with the alias
          const lines = currentYaml.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].match(/:\s*\*/)) {
              lineNumber = i + 1;
              break;
            }
          }
        }
      }

      // Reset attempt counter if error is on a later line
      if (lineNumber !== null && lastErrorLine !== null && lineNumber > lastErrorLine) {
        attempt = 0;
      }
      lastErrorLine = lineNumber;

      let fixApplied: boolean = false;
      // Handle specific errors
      if (
        yamlError.message.includes('implicit map key') ||
        yamlError.message.includes('Nested mappings are not allowed in compact mappings') ||
        yamlError.message.includes('Implicit map keys need to be on a single line')
      ) {
        // Likely an unquoted string with a colon
        currentYaml = fixUnquotedColon(currentYaml, lineNumber, colNumber);
        fixApplied = true;
      } else if (
        yamlError.message.includes('unclosed quoted string') ||
        yamlError.message.includes('unexpected scalar') ||
        yamlError.message.includes('Unexpected scalar at node end')
      ) {
        // Could be unescaped quotes or invalid alias reference
        if (yamlError.message.includes('Unexpected scalar at node end')) {
          // Check if it's an invalid alias reference (starts with *)
          const lines = currentYaml.split('\n');
          if (lineNumber && lines[lineNumber - 1]) {
            const line = lines[lineNumber - 1];
            const match = line.match(/:\s*\*(.+)$/);
            if (match) {
              // It's an invalid alias reference, quote it
              currentYaml = fixReservedCharacters(currentYaml, lineNumber, colNumber);
              fixApplied = true;
            } else {
              currentYaml = fixUnescapedQuotes(currentYaml, lineNumber, colNumber);
              fixApplied = true;
            }
          }
        } else {
          currentYaml = fixUnescapedQuotes(currentYaml, lineNumber, colNumber);
          fixApplied = true;
        }
      } else if (
        yamlError.message.includes('reserved indicator') ||
        yamlError.message.includes('Plain value cannot start with reserved character') ||
        yamlError.message.includes('Plain value cannot start with directive indicator') ||
        yamlError.message.includes('Block scalar header includes extra characters') ||
        yamlError.message.includes('Unresolved alias')
      ) {
        // String starting with @ or other reserved characters
        currentYaml = fixReservedCharacters(currentYaml, lineNumber, colNumber);
        fixApplied = true;
      } else {
        console.error('Unknown error type:', yamlError.message);
        break;
      }

      if (!fixApplied) {
        console.error('No fix applied for error:', yamlError.message);
        break;
      }
    }
  }

  throw new Error('Failed to fix YAML after maximum attempts.');
}

// Fix unquoted strings with colons
function fixUnquotedColon(
  yamlText: string,
  lineNumber: number | null,
  colNumber: number | null
): string {
  const lines: string[] = yamlText.split('\n');
  if (lineNumber && lines[lineNumber - 1]) {
    let line: string = lines[lineNumber - 1];

    // Match key-value pattern
    const keyValueMatch = line.match(/^(\s*)([^:]+):\s*(.*)$/);
    const arrayItemMatch = line.match(/^(\s*)-\s+(.*)$/);

    if (keyValueMatch) {
      const [, indent, key, value] = keyValueMatch;
      // Check if the value contains a colon and isn't already quoted
      if (
        value &&
        value.includes(':') &&
        !isValueQuoted(value) &&
        !value.startsWith('{') &&
        !value.startsWith('[')
      ) {
        // Quote the value
        const quotedValue: string = `"${value.replace(/"/g, '\\"')}"`;
        lines[lineNumber - 1] = `${indent}${key}: ${quotedValue}`;
      }
    } else if (arrayItemMatch) {
      const [, indent, value] = arrayItemMatch;
      // Check if array item value contains a colon and isn't already quoted
      if (value && value.includes(':') && !isValueQuoted(value)) {
        // Quote the array item value
        const quotedValue: string = `"${value.replace(/"/g, '\\"')}"`;
        lines[lineNumber - 1] = `${indent}- ${quotedValue}`;
      }
    }
  }
  return lines.join('\n');
}

// Fix unescaped quotes within strings
function fixUnescapedQuotes(
  yamlText: string,
  lineNumber: number | null,
  colNumber: number | null
): string {
  const lines: string[] = yamlText.split('\n');
  if (lineNumber && lines[lineNumber - 1]) {
    let line: string = lines[lineNumber - 1];
    const keyValueMatch = line.match(/^(\s*)([^:]+):\s*(.*)$/);
    if (keyValueMatch) {
      const [, indent, key, value] = keyValueMatch;
      if (value) {
        // Check if value is already quoted
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          // Fix unescaped quotes within the quoted string
          const quote = value[0];
          const content = value.slice(1, -1);
          const escapedContent = content.replace(
            new RegExp(`(?<!\\\\)${quote}`, 'g'),
            `\\${quote}`
          );
          lines[lineNumber - 1] = `${indent}${key}: ${quote}${escapedContent}${quote}`;
        } else if (value.includes('"')) {
          // If not quoted but has quotes, quote the entire string
          const escapedValue = value.replace(/"/g, '\\"');
          lines[lineNumber - 1] = `${indent}${key}: "${escapedValue}"`;
        }
      }
    }
  }
  return lines.join('\n');
}

// Fix strings starting with reserved characters (e.g., @, `)
function fixReservedCharacters(
  yamlText: string,
  lineNumber: number | null,
  colNumber: number | null
): string {
  const lines: string[] = yamlText.split('\n');
  if (lineNumber && lines[lineNumber - 1]) {
    let line: string = lines[lineNumber - 1];
    // Handle both key-value pairs and array items
    const keyValueMatch = line.match(/^(\s*)([^:]+):\s*(.*)$/);
    const arrayItemMatch = line.match(/^(\s*)-\s+(.*)$/);

    if (keyValueMatch) {
      const [, indent, key, value] = keyValueMatch;
      if (value) {
        const trimmedValue = value.trim();
        const reservedChars: string[] = ['@', '`', '%', '|', '>', '#', '*', '!', '&'];
        if (
          reservedChars.some((char: string) => trimmedValue.startsWith(char)) &&
          !isValueQuoted(value)
        ) {
          // Quote the value
          const quotedValue: string = `"${trimmedValue.replace(/"/g, '\\"')}"`;
          lines[lineNumber - 1] = `${indent}${key}: ${quotedValue}`;
        }
      }
    } else if (arrayItemMatch) {
      const [, indent, value] = arrayItemMatch;
      const trimmedValue = value.trim();
      const reservedChars: string[] = ['@', '`', '%', '|', '>', '#', '*', '!', '&'];
      if (
        reservedChars.some((char: string) => trimmedValue.startsWith(char)) &&
        !isValueQuoted(value)
      ) {
        // Quote the array item value
        const quotedValue: string = `"${trimmedValue.replace(/"/g, '\\"')}"`;
        lines[lineNumber - 1] = `${indent}- ${quotedValue}`;
      }
    }
  }
  return lines.join('\n');
}

// Helper to check if a string is already quoted
function isQuoted(line: string): boolean {
  const valueMatch: RegExpMatchArray | null = line.match(/:\s*(.*)$/);
  if (valueMatch) {
    const value: string = valueMatch[1].trim();
    return isValueQuoted(value);
  }
  return false;
}

// Helper to check if a value is quoted
function isValueQuoted(value: string): boolean {
  const trimmedValue = value.trim();
  return (
    (trimmedValue.startsWith('"') && trimmedValue.endsWith('"')) ||
    (trimmedValue.startsWith("'") && trimmedValue.endsWith("'"))
  );
}
