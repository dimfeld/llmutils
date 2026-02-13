/**
 * @fileoverview Standalone helper for setting up the permissions MCP infrastructure.
 *
 * This module extracts the permissions MCP setup logic so it can be reused by both
 * the ClaudeCodeExecutor class and the standalone `tim subagent` command. It handles:
 * - Parsing allowed tools into an efficient lookup structure
 * - Creating a Unix socket server for permission request handling
 * - Generating the MCP config file pointing to the permissions_mcp.ts script
 * - Interactive user prompting for non-allowed tools
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as net from 'net';
import chalk from 'chalk';
import { stringify } from 'yaml';
import {
  promptSelect,
  promptCheckbox,
  promptInput,
  isPromptTimeoutError,
} from '../../../common/input.js';
import { debugLog, log } from '../../../logging.js';
import { createLineSplitter } from '../../../common/process.js';

const BASH_TOOL_NAME = 'Bash';
const FREE_TEXT_VALUE = '__free_text__';

interface PermissionsMcpSetupResult {
  /** Path to the generated MCP config file */
  mcpConfigFile: string;
  /** The temporary directory created for MCP config and socket */
  tempDir: string;
  /** The Unix socket server handling permission requests */
  socketServer: net.Server;
  /** Cleanup function to tear down all resources */
  cleanup: () => Promise<void>;
}

interface PermissionsMcpOptions {
  /** List of allowed tool patterns (e.g., 'Edit', 'Bash(git status:*)') */
  allowedTools: string[];
  /** Default response when permission prompt times out */
  defaultResponse?: 'yes' | 'no';
  /** Timeout in milliseconds for permission prompts */
  timeout?: number;
  /** Auto-approve `rm` commands when all deleted files were created during this run */
  autoApproveCreatedFileDeletion?: boolean;
  /** Files created during this run; used by autoApproveCreatedFileDeletion */
  trackedFiles?: Set<string>;
  /** Base directory used to resolve relative paths in rm commands */
  workingDirectory?: string;
  /** Optional override for custom permission prompt behavior */
  createSocketServer?: (socketPath: string) => Promise<net.Server>;
}

function parseCommandTokens(command: string): string[] {
  const tokens: string[] = [];
  let currentToken = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escapeNext = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (escapeNext) {
      currentToken += char;
      escapeNext = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escapeNext = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === ' ' && !inSingleQuote && !inDoubleQuote) {
      if (currentToken) {
        tokens.push(currentToken);
        currentToken = '';
      }
      continue;
    }

    currentToken += char;
  }

  if (currentToken) {
    tokens.push(currentToken);
  }

  return tokens;
}

function parseRmCommand(command: string, workingDirectory: string): string[] {
  const trimmed = command.trim();
  if (!trimmed.match(/^rm(\s|$)/)) {
    return [];
  }

  const tokens = parseCommandTokens(trimmed);
  if (tokens.length === 0 || tokens[0] !== 'rm') {
    return [];
  }

  const filePaths: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('-')) {
      continue;
    }
    if (!token.trim()) {
      continue;
    }
    if (token.includes('*') || token.includes('?') || token.includes('[')) {
      continue;
    }

    filePaths.push(path.isAbsolute(token) ? token : path.resolve(workingDirectory, token));
  }

  return filePaths;
}

/**
 * Parses allowed tools list into an efficient lookup structure.
 *
 * Returns a Map where:
 * - Non-Bash tools map to `true` (simple allow)
 * - Bash maps to an array of allowed command prefixes
 */
export function parseAllowedToolsList(allowedTools: string[]): Map<string, true | string[]> {
  const result = new Map<string, true | string[]>();

  for (const tool of allowedTools) {
    if (typeof tool !== 'string' || tool.trim() === '') {
      continue;
    }

    const trimmedTool = tool.trim();

    if (trimmedTool.startsWith(`${BASH_TOOL_NAME}(`)) {
      if (!trimmedTool.endsWith(')')) {
        debugLog(`Skipping malformed Bash tool configuration: ${trimmedTool}`);
        continue;
      }

      const bashCommand = trimmedTool.slice(5, -1); // Remove "Bash(" and ")"
      if (bashCommand.trim() === '') {
        continue;
      }

      let commandPrefix: string;
      if (bashCommand.endsWith(':*')) {
        commandPrefix = bashCommand.slice(0, -2).trim();
        if (commandPrefix === '') {
          continue;
        }
      } else {
        commandPrefix = bashCommand.trim();
      }

      const existing = result.get(BASH_TOOL_NAME);
      if (Array.isArray(existing)) {
        if (!existing.includes(commandPrefix)) {
          existing.push(commandPrefix);
        }
      } else {
        result.set(BASH_TOOL_NAME, [commandPrefix]);
      }
    } else {
      if (!result.has(trimmedTool)) {
        result.set(trimmedTool, true);
      }
    }
  }

  return result;
}

async function handleAskUserQuestion(
  message: { requestId?: string; tool_name?: string; input?: any },
  socket: net.Socket,
  options: Pick<PermissionsMcpOptions, 'timeout'>
): Promise<void> {
  const requestId = message.requestId!;
  const questions = Array.isArray(message.input?.questions) ? message.input.questions : [];

  if (questions.length === 0) {
    const response = {
      type: 'permission_response',
      requestId,
      approved: false,
    };
    socket.write(JSON.stringify(response) + '\n');
    return;
  }

  process.stdout.write('\x07');
  const answers: Record<string, string> = {};

  try {
    for (const question of questions) {
      const promptQuestion =
        typeof question?.question === 'string' && question.question.length > 0
          ? question.question
          : 'Question';
      const promptHeader =
        typeof question?.header === 'string' && question.header.length > 0
          ? question.header
          : 'Question';
      const isMultiSelect = question?.multiSelect === true;

      const choices = Array.isArray(question?.options)
        ? question.options
            .filter((option: any) => typeof option?.label === 'string')
            .map((option: any) => ({
              name: option.label,
              value: option.label,
              description:
                typeof option.description === 'string' && option.description.length > 0
                  ? option.description
                  : undefined,
            }))
        : [];

      choices.push({
        name: 'Free text',
        value: FREE_TEXT_VALUE,
      });

      console.log(`\n${chalk.bold(promptHeader)}: ${chalk.white(promptQuestion)}`);

      if (isMultiSelect) {
        const selectedValues = await promptCheckbox<string>({
          message: 'Select one or more answers',
          choices,
          timeoutMs: options.timeout,
        });

        const selectedAnswers = selectedValues.filter((value) => value !== FREE_TEXT_VALUE);
        if (selectedValues.includes(FREE_TEXT_VALUE)) {
          const freeTextValue = await promptInput({
            message: 'Enter custom answer',
            timeoutMs: options.timeout,
          });
          selectedAnswers.push(freeTextValue);
        }

        answers[promptQuestion] = selectedAnswers.join(', ');
      } else {
        const selectedValue = await promptSelect<string>({
          message: 'Select an answer',
          choices,
          timeoutMs: options.timeout,
        });

        if (selectedValue === FREE_TEXT_VALUE) {
          answers[promptQuestion] = await promptInput({
            message: 'Enter custom answer',
            timeoutMs: options.timeout,
          });
        } else {
          answers[promptQuestion] = selectedValue;
        }
      }
    }
  } catch (err) {
    if (isPromptTimeoutError(err)) {
      log('\nAskUserQuestion prompt timed out; denying request');
    } else {
      log(`AskUserQuestion prompt failed: ${err as Error}`);
    }

    const response = {
      type: 'permission_response',
      requestId,
      approved: false,
    };
    socket.write(JSON.stringify(response) + '\n');
    return;
  }

  const response = {
    type: 'permission_response',
    requestId,
    approved: true,
    updatedInput: {
      questions,
      answers,
    },
  };
  socket.write(JSON.stringify(response) + '\n');
}

async function handlePermissionLine(
  line: string,
  socket: net.Socket,
  allowedToolsMap: Map<string, true | string[]>,
  options: Pick<
    PermissionsMcpOptions,
    | 'defaultResponse'
    | 'timeout'
    | 'autoApproveCreatedFileDeletion'
    | 'trackedFiles'
    | 'workingDirectory'
  >
): Promise<void> {
  let message: { type?: string; requestId?: string; tool_name?: string; input?: any };
  try {
    message = JSON.parse(line);
  } catch (err) {
    debugLog('Failed to parse permission request JSON:', err);
    return;
  }

  if (message.type !== 'permission_request') {
    return;
  }

  const { requestId, tool_name, input } = message;

  if (!requestId || !tool_name) {
    debugLog('Permission request missing requestId or tool_name');
    return;
  }

  try {
    if (tool_name === 'AskUserQuestion') {
      await handleAskUserQuestion(message, socket, {
        timeout: options.timeout,
      });
      return;
    }

    // Check if this tool is in the allowed set
    const allowedValue = allowedToolsMap.get(tool_name);
    if (allowedValue !== undefined) {
      if (tool_name === BASH_TOOL_NAME && Array.isArray(allowedValue)) {
        if (typeof input.command === 'string') {
          const command = input.command;
          const isAllowed = allowedValue.some((prefix) => command.startsWith(prefix));

          if (isAllowed) {
            const response = {
              type: 'permission_response',
              requestId,
              approved: true,
            };
            socket.write(JSON.stringify(response) + '\n');
            return;
          }
        }
      } else if (allowedValue === true) {
        const response = {
          type: 'permission_response',
          requestId,
          approved: true,
        };
        socket.write(JSON.stringify(response) + '\n');
        return;
      }
    }

    if (
      options.autoApproveCreatedFileDeletion === true &&
      tool_name === BASH_TOOL_NAME &&
      typeof input.command === 'string'
    ) {
      const baseDir = options.workingDirectory ?? process.cwd();
      const filesToDelete = parseRmCommand(input.command, baseDir);
      if (
        filesToDelete.length > 0 &&
        options.trackedFiles &&
        filesToDelete.every((filePath) => options.trackedFiles!.has(filePath))
      ) {
        const response = {
          type: 'permission_response',
          requestId,
          approved: true,
        };
        socket.write(JSON.stringify(response) + '\n');
        return;
      }
    }

    // Not in the allowed list -- prompt the user
    let formattedInput = stringify(input);
    if (formattedInput.length > 500) {
      formattedInput = formattedInput.substring(0, 500) + '...';
    }

    // Alert the user
    process.stdout.write('\x07');

    let approved: boolean;
    try {
      const userChoice = await promptSelect({
        message: `Claude wants to run a tool:\n\nTool: ${chalk.blue(tool_name)}\nInput:\n${chalk.white(formattedInput)}\n\nAllow this tool to run?`,
        choices: [
          { name: 'Allow', value: 'allow' as const },
          { name: 'Allow for Session', value: 'session_allow' as const },
          { name: 'Disallow', value: 'disallow' as const },
        ],
        timeoutMs: options.timeout,
      });

      approved = userChoice === 'allow' || userChoice === 'session_allow';

      // For session allow, add to the allowed map for future requests
      if (userChoice === 'session_allow') {
        if (tool_name === BASH_TOOL_NAME && typeof input.command === 'string') {
          const existing = allowedToolsMap.get(BASH_TOOL_NAME);
          const prefix = input.command.split(' ')[0];
          if (Array.isArray(existing)) {
            if (!existing.includes(prefix)) {
              existing.push(prefix);
            }
          } else {
            allowedToolsMap.set(BASH_TOOL_NAME, [prefix]);
          }
        } else {
          allowedToolsMap.set(tool_name, true);
        }
      }
    } catch (err) {
      if (isPromptTimeoutError(err)) {
        // Prompt was aborted due to timeout - apply configured default
        const defaultResp = options.defaultResponse ?? 'no';
        approved = defaultResp === 'yes';
        log(`\nPermission prompt timed out, using default: ${defaultResp}`);
      } else {
        // Transport error, tunnel disconnect, or unexpected failure - deny for safety
        approved = false;
        debugLog('Permission prompt failed with non-timeout error:', err);
      }
    }

    const response = {
      type: 'permission_response',
      requestId,
      approved,
    };
    socket.write(JSON.stringify(response) + '\n');
  } catch (err) {
    debugLog('Permission handler failed:', err);
    const response = {
      type: 'permission_response',
      requestId,
      approved: false,
    };
    socket.write(JSON.stringify(response) + '\n');
  }
}

/**
 * Creates a Unix socket server that handles permission requests from the
 * permissions MCP script. Auto-approves tools in the allowed list and
 * prompts the user interactively for others.
 */
function createPermissionSocketServer(
  socketPath: string,
  allowedToolsMap: Map<string, true | string[]>,
  options: Pick<
    PermissionsMcpOptions,
    | 'defaultResponse'
    | 'timeout'
    | 'autoApproveCreatedFileDeletion'
    | 'trackedFiles'
    | 'workingDirectory'
  >
): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      const splitLines = createLineSplitter();

      socket.on('data', (data) => {
        const lines = splitLines(data.toString());
        for (const line of lines) {
          if (!line) continue;
          void handlePermissionLine(line, socket, allowedToolsMap, options).catch((err) => {
            debugLog('Permission handler failed:', err);
          });
        }
      });
    });

    server.on('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

/**
 * Sets up the full permissions MCP infrastructure for a Claude Code subprocess.
 *
 * Creates a temporary directory with:
 * - A Unix socket for permission request handling
 * - An MCP config file pointing to the permissions_mcp.ts script
 *
 * Returns the config file path and a cleanup function.
 */
export async function setupPermissionsMcp(
  options: PermissionsMcpOptions
): Promise<PermissionsMcpSetupResult> {
  const allowedToolsMap = parseAllowedToolsList(options.allowedTools);

  // Create a temporary directory for the MCP config and socket
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-subagent-mcp-'));
  const socketPath = path.join(tempDir, 'permissions.sock');

  // Create the socket server
  const socketServer = options.createSocketServer
    ? await options.createSocketServer(socketPath)
    : await createPermissionSocketServer(socketPath, allowedToolsMap, {
        defaultResponse: options.defaultResponse,
        timeout: options.timeout,
        autoApproveCreatedFileDeletion: options.autoApproveCreatedFileDeletion,
        trackedFiles: options.trackedFiles,
        workingDirectory: options.workingDirectory,
      });

  // Resolve the path to the permissions MCP script
  // Try .ts first (development), fall back to .js (compiled)
  let permissionsMcpPath = path.resolve(import.meta.dir, './permissions_mcp.ts');
  try {
    await fs.access(permissionsMcpPath);
  } catch {
    permissionsMcpPath = path.resolve(import.meta.dir, './claude_code/permissions_mcp.js');
  }

  // Build the MCP config
  const mcpConfig = {
    mcpServers: {
      permissions: {
        type: 'stdio',
        command: process.execPath,
        args: [permissionsMcpPath, socketPath],
      },
    },
  };

  // Write the config file
  const mcpConfigFile = path.join(tempDir, 'mcp-config.json');
  await fs.writeFile(mcpConfigFile, JSON.stringify(mcpConfig, null, 2));

  const cleanup = async () => {
    await new Promise<void>((resolve) => {
      socketServer.close(() => resolve());
    });
    await fs.rm(tempDir, { recursive: true, force: true });
  };

  return {
    mcpConfigFile,
    tempDir,
    socketServer,
    cleanup,
  };
}
