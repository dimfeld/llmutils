import * as YAML from 'yaml';
import { streamText } from 'ai';
import { createModel } from '../common/model_factory.js';
import type { RmplanConfig } from './configSchema.js';
import { findYamlStart } from './process_markdown.js';
import { quiet } from '../common/process.js';
import type { GoogleGenerativeAIProviderOptions } from '@ai-sdk/google';

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
export async function fixYaml(inputYaml: string, maxAttempts: number = 5, config?: RmplanConfig) {
  let currentYaml: string = inputYaml;
  let attempt: number = 0;
  let lastErrorLine: number | null = null;
  let lastError: Error | undefined;

  while (attempt < maxAttempts) {
    try {
      // Attempt to parse the YAML
      let parsedYaml = YAML.parse(currentYaml);
      return parsedYaml;
    } catch (error: unknown) {
      lastError = error as Error;
      if (attempt === maxAttempts - 1) {
        break;
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
        yamlError.message.includes('Implicit map keys need to be on a single line') ||
        (yamlError.message.includes('Implicit keys need to be on a single line') &&
          yamlError.code !== 'MULTILINE_IMPLICIT_KEY')
      ) {
        // Likely an unquoted string with a colon
        currentYaml = fixUnquotedColon(currentYaml, lineNumber, colNumber);
        fixApplied = true;
      } else if (
        yamlError.message.includes('Implicit keys need to be on a single line') &&
        yamlError.code === 'MULTILINE_IMPLICIT_KEY'
      ) {
        // This is specifically a multiline quote issue
        currentYaml = fixMissingClosingQuote(currentYaml, lineNumber, colNumber);
        fixApplied = true;
      } else if (
        yamlError.message.includes('unclosed quoted string') ||
        yamlError.message.includes('unexpected scalar') ||
        yamlError.message.includes('Unexpected scalar at node end') ||
        yamlError.message.includes('Missing closing "quote')
      ) {
        // Could be unescaped quotes, invalid alias reference, or missing closing quote
        if (
          yamlError.message.includes('Missing closing "quote') ||
          yamlError.code === 'MISSING_CHAR'
        ) {
          // Handle missing closing quote for strings that span lines
          currentYaml = fixMissingClosingQuote(currentYaml, lineNumber, colNumber);
          fixApplied = true;
        } else if (yamlError.message.includes('Unexpected scalar at node end')) {
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

  // If we reach here, manual fixes failed. Try LLM fallback if config is provided
  if (config) {
    try {
      console.log(`Attempting to fix YAML with LLM...`);
      const fixedYaml = await fixYamlWithLLM(currentYaml, config);
      return YAML.parse(findYamlStart(fixedYaml));
    } catch (llmError) {
      throw new Error(
        `Failed to fix YAML after maximum attempts and LLM fallback failed: ${llmError as Error}`
      );
    }
  }

  throw new Error(`Failed to fix YAML after maximum attempts: ${lastError}`);
}

// Function to fix YAML using LLM
async function fixYamlWithLLM(yamlText: string, config: RmplanConfig): Promise<string> {
  const modelSpec = config.models?.convert_yaml || 'google/gemini-2.5-flash-preview-05-20';

  const prompt = `You are an AI assistant specialized in fixing invalid YAML syntax. Your task is to take the provided YAML text and fix any syntax errors to make it valid YAML.

**Input YAML:**

\`\`\`yaml
${yamlText}
\`\`\`

**Instructions:**

1. Fix any YAML syntax errors such as:
   - Unquoted strings containing special characters
   - Incorrect indentation
   - Unclosed quotes
   - Invalid escape sequences
   - Reserved character issues

2. Preserve the original structure and content as much as possible
3. Only fix syntax issues, do not change the meaning or structure
4. Use proper YAML quoting when necessary
5. Ensure proper indentation (2 spaces per level)

**Output Format:** Return only the fixed YAML content without any explanations, comments, or markdown fences.`;

  const result = streamText({
    model: await createModel(modelSpec, config),
    prompt,
    temperature: 0,
    providerOptions: {
      google: {
        thinkingConfig: {
          thinkingBudget: 0,
        },
      } satisfies GoogleGenerativeAIProviderOptions,
    },
  });

  if (!quiet) {
    for await (const chunk of result.fullStream) {
      if (chunk.type === 'text-delta') {
        process.stdout.write(chunk.textDelta);
      } else if (chunk.type === 'error') {
        throw new Error((chunk.error as any).toString());
      }
    }
    process.stdout.write('\n');
  }

  return await result.text;
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

// Fix missing closing quote for strings that span multiple lines
function fixMissingClosingQuote(
  yamlText: string,
  lineNumber: number | null,
  colNumber: number | null
): string {
  const lines: string[] = yamlText.split('\n');
  if (!lineNumber) return yamlText;

  // Find the line with the unclosed quote by looking backwards from the error line
  for (let i = Math.min(lineNumber - 1, lines.length - 1); i >= 0; i--) {
    const line = lines[i];
    const keyValueMatch = line.match(/^(\s*)([^:]+):\s*"(.*)$/);
    if (keyValueMatch) {
      const [, indent, key, valueStart] = keyValueMatch;

      // Collect all content from this line until we hit the next key at the same indentation level
      let fullValue = valueStart;
      let endLine = i;

      // Look for the end of the value content
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];

        // Check if we've hit another key at the same or lesser indentation
        const nextKeyMatch = nextLine.match(/^(\s*)([\w-]+):/);
        if (nextKeyMatch) {
          const nextIndent = nextKeyMatch[1];
          if (nextIndent.length <= indent.length) {
            // Found the end of our value
            break;
          }
        }

        // Check if we've hit another array item at a similar indentation level
        const arrayItemMatch = nextLine.match(/^(\s*)-\s+(\w+):/);
        if (arrayItemMatch) {
          const arrayIndent = arrayItemMatch[1];
          // If this array item is at the same or higher level (less indented), stop
          if (arrayIndent.length <= indent.length) {
            break;
          }
        }

        // Add the line content to our value
        fullValue += '\n' + nextLine;
        endLine = j;
      }

      // Clean up the value - remove any trailing quotes and escape internal quotes
      fullValue = fullValue.replace(/"$/, ''); // Remove trailing quote if present

      // Escape newlines and quotes for proper YAML flow scalar format
      const escapedValue = fullValue
        .replace(/"/g, '\\"') // Escape internal quotes
        .replace(/\n/g, '\\n'); // Escape newlines

      // Replace the original lines with the fixed version
      const newLine = `${indent}${key}: "${escapedValue}"`;
      const newLines = [...lines];
      newLines.splice(i, endLine - i + 1, newLine);

      return newLines.join('\n');
    }
  }

  return yamlText;
}
