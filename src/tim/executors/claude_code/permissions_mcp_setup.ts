/**
 * @fileoverview Standalone helper for setting up the permissions MCP infrastructure.
 *
 * This module extracts the permissions MCP setup logic so it can be reused by both
 * the ClaudeCodeExecutor class and the standalone `tim subagent` command. It handles:
 * - Parsing allowed tools into an efficient lookup structure
 * - Creating a Unix socket server for permission request handling
 * - Generating the MCP config file pointing to the tim_mcp.ts script
 * - Interactive user prompting for non-allowed tools
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as net from 'net';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { stringify } from 'yaml';
import {
  promptSelect,
  promptCheckbox,
  promptInput,
  promptPrefixSelect,
  isPromptTimeoutError,
} from '../../../common/input.js';
import { getGitRoot } from '../../../common/git.js';
import { extractCommandAfterCd } from '../../../common/prefix_prompt_utils.js';
import { debugLog, log } from '../../../logging.js';
import { getRepositoryIdentity } from '../../assignments/workspace_identifier.js';
import { getDatabase } from '../../db/database.js';
import { getOrCreateProject } from '../../db/project.js';
import { addPermission } from '../../db/permission.js';
import {
  CLAUDE_AGENT_TOOL_NAMES,
  CLAUDE_MCP_SERVER_NAME,
  agentToolRequestSchema,
  callerIdentityFromAgent,
  getClaudeAgentArgumentSchema,
  getClaudeAgentToolNames,
  permissionRequestSchema,
  type ClaudeAgentToolContext,
  type ClaudePermissionPromptCoordinator,
} from './claude_mcp_protocol.js';
import { isClaudePermissionPromptCancelledError } from './claude_permission_prompt_coordinator.js';
import type { AgentIdentity } from '../../agent_messaging/agent_manager_types.js';

const BASH_TOOL_NAME = 'Bash';
const FREE_TEXT_VALUE = '__free_text__';
const USER_CHOICE_ALLOW = 'allow';
const USER_CHOICE_ALWAYS_ALLOW = 'always_allow';
const USER_CHOICE_SESSION_ALLOW = 'session_allow';
const USER_CHOICE_DISALLOW = 'disallow';
const MAX_CLAUDE_MCP_JSON_SIZE = 1024 * 1024;
export const ALWAYS_ALLOWED_BASH_SUFFIXES: string[] = ['tim tools update-plan-tasks'];

interface PermissionsMcpSetupResult {
  /** Path to the generated MCP config file */
  mcpConfigFile: string;
  /** The temporary directory created for MCP config and socket */
  tempDir: string;
  /** Path to the permissions MCP log file */
  logFile: string;
  /** The Unix socket server handling permission requests */
  socketServer: net.Server;
  /** Cleanup function to tear down all resources */
  cleanup: () => Promise<void>;
}

export interface PermissionsMcpOptions {
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
  /** Enable the approval_prompt child tool. Defaults to true for compatibility. */
  interactiveApprovalEnabled?: boolean;
  /** Trusted parent-bound context for role-scoped agent tools. */
  agentToolContext?: ClaudeAgentToolContext;
  /** Shared root-session coordinator for interactive prompt cancellation. */
  permissionPromptCoordinator?: ClaudePermissionPromptCoordinator;
  /** Optional user MCP config to preserve when installing the internal bridge. */
  mcpConfigFile?: string;
}

export interface ClaudeMcpConfig {
  readonly [key: string]: unknown;
  readonly mcpServers?: Record<string, unknown>;
}

export interface ClaudeMcpServerDefinition {
  readonly type: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Read and validate a user MCP config before the bridge allocates any resources.
 * The returned object is a new value so setup never mutates the user's file.
 */
export async function readUserMcpConfig(
  mcpConfigFile: string | undefined
): Promise<ClaudeMcpConfig> {
  if (mcpConfigFile === undefined) return {};

  let content: string;
  try {
    content = await fs.readFile(mcpConfigFile, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read Claude MCP config file ${mcpConfigFile}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Claude MCP config file ${mcpConfigFile} contains invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`Claude MCP config file ${mcpConfigFile} must contain a JSON object`);
  }
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw new Error(`Claude MCP config file ${mcpConfigFile} must define mcpServers as an object`);
  }

  return parsed;
}

export function mergeClaudeMcpConfig(
  userConfig: ClaudeMcpConfig,
  internalServer: ClaudeMcpServerDefinition
): ClaudeMcpConfig {
  const userServers = userConfig.mcpServers ?? {};
  assertClaudeMcpServerNameAvailable(userServers);

  return {
    ...userConfig,
    mcpServers: {
      ...userServers,
      [CLAUDE_MCP_SERVER_NAME]: internalServer,
    },
  };
}

function assertClaudeMcpServerNameAvailable(userServers: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(userServers, CLAUDE_MCP_SERVER_NAME)) {
    throw new Error(
      `Claude MCP server name collision: ${CLAUDE_MCP_SERVER_NAME} is reserved for tim's internal bridge`
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateAgentIdentity(identity: AgentIdentity): void {
  if (!isRecord(identity) || (identity.role !== 'orchestrator' && identity.role !== 'subagent')) {
    throw new TypeError('Claude agent tool caller identity is invalid');
  }
  if (typeof identity.id !== 'string' || typeof identity.name !== 'string') {
    throw new TypeError('Claude agent tool caller identity must include id and name');
  }
}

export function validateClaudeAgentToolContext(context: ClaudeAgentToolContext): void {
  if (!isRecord(context)) throw new TypeError('Claude agent tool context must be an object');
  validateAgentIdentity(context.caller);
  if (!(context.allowedTools instanceof Set)) {
    throw new TypeError('Claude agent tool context allowedTools must be a Set');
  }
  if (!isRecord(context.dispatcher)) {
    throw new TypeError('Claude agent tool context dispatcher must be an object');
  }
  for (const method of [
    'startAgent',
    'listAgents',
    'sendAgentMessage',
    'stopAgent',
    'finishAgent',
  ]) {
    if (typeof context.dispatcher[method] !== 'function') {
      throw new TypeError(`Claude agent tool dispatcher ${method} must be a function`);
    }
  }

  const roleTools = new Set(getClaudeAgentToolNames(context.caller.role));
  for (const toolName of context.allowedTools) {
    if (!(CLAUDE_AGENT_TOOL_NAMES as readonly string[]).includes(toolName)) {
      throw new TypeError(`Unknown Claude agent tool in context: ${String(toolName)}`);
    }
    if (!roleTools.has(toolName)) {
      throw new TypeError(
        `Claude agent tool ${toolName} is not allowed for ${context.caller.role} callers`
      );
    }
  }
}

function getRequesterName(context: ClaudeAgentToolContext | undefined): string | undefined {
  return context?.caller.name;
}

function getRequestId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.requestId === 'string' ? value.requestId : undefined;
}

function writeSocketMessage(socket: net.Socket, value: unknown): void {
  if (socket.destroyed) return;
  try {
    socket.write(`${JSON.stringify(value)}\n`);
  } catch (error) {
    debugLog('Could not write Claude MCP response:', error);
  }
}

function writeAgentToolError(socket: net.Socket, requestId: string, error: unknown): void {
  writeSocketMessage(socket, {
    type: 'agent_tool_response',
    requestId,
    success: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

function createBoundedLineSplitter(): (input: string) => string[] {
  let fragment = '';
  return (input: string): string[] => {
    const lines = (fragment + input).split('\n');
    fragment = lines.pop() ?? '';
    if (fragment.length > MAX_CLAUDE_MCP_JSON_SIZE) {
      fragment = '';
      throw new Error('Claude MCP request exceeded the maximum JSON line size');
    }
    return lines.filter((line) => line.length <= MAX_CLAUDE_MCP_JSON_SIZE);
  };
}

async function enqueueInteractivePrompt<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: Pick<PermissionsMcpOptions, 'permissionPromptCoordinator'>,
  requester: { readonly name: string; readonly token: string },
  requestId: string
): Promise<T> {
  if (options.permissionPromptCoordinator === undefined) {
    return operation(new AbortController().signal);
  }
  return options.permissionPromptCoordinator.enqueue({
    requesterName: requester.name,
    requesterToken: requester.token,
    requestId,
    run: operation,
  });
}

export async function resolvePermissionsMcpPath(
  executableDir: string = path.dirname(process.execPath)
): Promise<string> {
  // Resolve the path to the permissions MCP script
  // Prefer the compiled script relative to the executable, then fall back to the local source file.
  // Use import.meta.dir (Bun) or import.meta.dirname (Node.js v20+) or URL-based fallback
  const currentDir =
    (import.meta as { dir?: string; dirname?: string }).dir ??
    (import.meta as { dirname?: string }).dirname ??
    path.dirname(new URL(import.meta.url).pathname);
  const distPath = './claude_code/tim_mcp.js';
  const candidates: string[] = [
    path.resolve(executableDir, distPath),
    path.resolve(path.dirname(process.argv0), distPath),
    path.resolve(currentDir, './tim_mcp.ts'),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return candidates.at(-1) as string;
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

function addBashPrefixSafely(
  allowedToolsMap: Map<string, true | string[]>,
  prefix: string
): boolean {
  const existingValue = allowedToolsMap.get(BASH_TOOL_NAME);

  if (existingValue !== undefined && !Array.isArray(existingValue) && !existingValue) {
    debugLog(
      `Warning: Unexpected value type for ${BASH_TOOL_NAME} in allowedToolsMap: ${typeof existingValue}`
    );
    allowedToolsMap.set(BASH_TOOL_NAME, [prefix]);
    return true;
  }

  if (Array.isArray(existingValue)) {
    if (!existingValue.includes(prefix)) {
      existingValue.push(prefix);
      return true;
    }
    return false;
  }

  if (existingValue === undefined) {
    allowedToolsMap.set(BASH_TOOL_NAME, [prefix]);
    return true;
  }

  // existingValue === true means all Bash is already allowed.
  return false;
}

export async function addPermissionToFile(
  toolName: string,
  argument?: { exact: boolean; command?: string },
  workingDirectory?: string
): Promise<void> {
  try {
    const gitRoot = await getGitRoot(workingDirectory);
    const settingsPath = path.join(gitRoot, '.claude', 'settings.local.json');

    let settings: any = {};
    try {
      const settingsContent = await fs.readFile(settingsPath, 'utf-8');
      settings = JSON.parse(settingsContent);
    } catch {
      settings = {
        permissions: {
          allow: [],
          deny: [],
        },
      };
    }

    settings.permissions ??= { allow: [], deny: [] };
    settings.permissions.allow ??= [];

    let newRule: string;
    if (toolName === BASH_TOOL_NAME && argument) {
      if (argument.exact) {
        newRule = `${BASH_TOOL_NAME}(${argument.command})`;
      } else {
        newRule = `${BASH_TOOL_NAME}(${argument.command}:*)`;
      }
    } else {
      newRule = toolName;
    }

    if (!settings.permissions.allow.includes(newRule)) {
      settings.permissions.allow.push(newRule);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    }

    try {
      const identity = await getRepositoryIdentity({ cwd: workingDirectory });
      const db = getDatabase();
      const project = getOrCreateProject(db, identity.repositoryId, {
        remoteUrl: identity.remoteUrl,
      });
      addPermission(db, project.id, 'allow', newRule);
    } catch (sharedErr) {
      debugLog('Could not save permission to shared storage:', sharedErr);
    }
  } catch (err) {
    debugLog('Could not save permission to Claude settings:', err);
  }
}

async function handleBashPrefixApproval(
  input: any,
  allowedToolsMap: Map<string, true | string[]>,
  isPersistent: boolean,
  sessionMessage: string,
  persistentMessage: string,
  timeout?: number,
  workingDirectory?: string,
  signal?: AbortSignal
): Promise<void> {
  const command = input.command as string;
  const selectedPrefix = await promptPrefixSelect({
    message: isPersistent
      ? 'Select the command prefix to always allow:'
      : 'Select the command prefix to allow for this session:',
    command,
    timeoutMs: timeout,
    signal,
  });

  const wasAdded = addBashPrefixSafely(allowedToolsMap, selectedPrefix.command);
  if (wasAdded) {
    const message = isPersistent ? persistentMessage : sessionMessage;
    log(chalk.blue(message.replace('{prefix}', selectedPrefix.command)));
  } else {
    log(chalk.yellow(`Bash prefix "${selectedPrefix.command}" was already in the allowed list`));
  }

  if (isPersistent) {
    await addPermissionToFile(BASH_TOOL_NAME, selectedPrefix, workingDirectory);
  }
}

async function handleAskUserQuestion(
  message: { requestId: string; tool_name: string; input: Record<string, unknown> },
  socket: net.Socket,
  requesterName: string,
  signal: AbortSignal
): Promise<void> {
  const requestId = message.requestId;
  const questions = Array.isArray(message.input?.questions) ? message.input.questions : [];

  if (questions.length === 0) {
    const response = {
      type: 'permission_response',
      requestId,
      approved: false,
    };
    writeSocketMessage(socket, response);
    return;
  }

  process.stdout.write('\x07');
  if (requesterName) {
    console.log(`\nClaude agent ${requesterName} wants to answer questions:`);
  }
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
          header: promptHeader,
          question: promptQuestion,
          choices,
          signal,
        });

        const selectedAnswers = selectedValues.filter((value) => value !== FREE_TEXT_VALUE);
        if (selectedValues.includes(FREE_TEXT_VALUE)) {
          const freeTextValue = await promptInput({
            message: 'Enter custom answer',
            signal,
          });
          selectedAnswers.push(freeTextValue);
        }

        answers[promptQuestion] = selectedAnswers.join(', ');
      } else {
        const selectedValue = await promptSelect<string>({
          message: 'Select an answer',
          header: promptHeader,
          question: promptQuestion,
          choices,
          signal,
        });

        if (selectedValue === FREE_TEXT_VALUE) {
          answers[promptQuestion] = await promptInput({
            message: 'Enter custom answer',
            signal,
          });
        } else {
          answers[promptQuestion] = selectedValue;
        }
      }
    }
  } catch (err) {
    if (signal.aborted) {
      throw err;
    }
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
    writeSocketMessage(socket, response);
    return;
  }

  if (signal.aborted) {
    throw new Error('Claude permission prompt was cancelled');
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
  writeSocketMessage(socket, response);
}

async function handlePermissionLine(
  line: string,
  socket: net.Socket,
  allowedToolsMap: Map<string, true | string[]>,
  requester: { readonly name: string; readonly token: string },
  options: Pick<
    PermissionsMcpOptions,
    | 'defaultResponse'
    | 'timeout'
    | 'autoApproveCreatedFileDeletion'
    | 'trackedFiles'
    | 'workingDirectory'
    | 'permissionPromptCoordinator'
  >
): Promise<void> {
  let rawMessage: unknown;
  try {
    rawMessage = JSON.parse(line);
  } catch (error) {
    debugLog('Failed to parse permission request JSON:', error);
    return;
  }

  if (!isRecord(rawMessage) || rawMessage.type !== 'permission_request') {
    return;
  }

  const parsed = permissionRequestSchema.safeParse(rawMessage);
  const requestId = getRequestId(rawMessage);
  if (!parsed.success) {
    debugLog('Invalid permission request:', parsed.error.issues);
    if (requestId !== undefined) {
      writeSocketMessage(socket, {
        type: 'permission_response',
        requestId,
        approved: false,
      });
    }
    return;
  }
  const message = parsed.data;
  const { tool_name, input } = message;

  try {
    if (tool_name === 'AskUserQuestion') {
      // AskUserQuestion must always wait for explicit user input and never auto-timeout.
      if (!Array.isArray(input.questions) || input.questions.length === 0) {
        await handleAskUserQuestion(message, socket, requester.name, new AbortController().signal);
        return;
      }
      await enqueueInteractivePrompt(
        (signal) => handleAskUserQuestion(message, socket, requester.name, signal),
        options,
        requester,
        message.requestId
      );
      return;
    }

    // Check if this tool is in the allowed set
    const allowedValue = allowedToolsMap.get(tool_name);
    if (allowedValue !== undefined) {
      if (tool_name === BASH_TOOL_NAME && Array.isArray(allowedValue)) {
        if (typeof input.command === 'string') {
          const command = input.command;
          const strippedCommand = extractCommandAfterCd(command);
          const isAllowed = allowedValue.some(
            (prefix) => command.startsWith(prefix) || strippedCommand.startsWith(prefix)
          );

          if (isAllowed) {
            const response = {
              type: 'permission_response',
              requestId,
              approved: true,
            };
            writeSocketMessage(socket, response);
            return;
          }
        }
      } else if (allowedValue === true) {
        const response = {
          type: 'permission_response',
          requestId,
          approved: true,
        };
        writeSocketMessage(socket, response);
        return;
      }
    }

    if (tool_name === BASH_TOOL_NAME && typeof input.command === 'string') {
      const trimmedCommand = input.command.trimEnd();
      if (ALWAYS_ALLOWED_BASH_SUFFIXES.some((suffix) => trimmedCommand.endsWith(suffix))) {
        const response = {
          type: 'permission_response',
          requestId,
          approved: true,
        };
        writeSocketMessage(socket, response);
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
        writeSocketMessage(socket, response);
        return;
      }
    }

    // Not in the allowed list -- prompt the user
    let formattedInput = stringify(input);
    if (formattedInput.length > 500) {
      formattedInput = formattedInput.substring(0, 500) + '...';
    }

    let approved: boolean;
    try {
      approved = await enqueueInteractivePrompt(
        async (signal: AbortSignal): Promise<boolean> => {
          process.stdout.write('\x07');
          try {
            const userChoice = await promptSelect({
              message: `${requester.name ? `Claude agent ${requester.name}` : 'Claude'} wants to run a tool:\n\nTool: ${chalk.blue(tool_name)}\nInput:\n${chalk.white(formattedInput)}\n\nAllow this tool to run?`,
              choices: [
                { name: 'Allow', value: USER_CHOICE_ALLOW },
                { name: 'Allow for Session', value: USER_CHOICE_SESSION_ALLOW },
                { name: 'Always Allow', value: USER_CHOICE_ALWAYS_ALLOW },
                { name: 'Disallow', value: USER_CHOICE_DISALLOW },
              ],
              timeoutMs: options.timeout,
              signal,
            });

            const promptApproved =
              userChoice === USER_CHOICE_ALLOW ||
              userChoice === USER_CHOICE_SESSION_ALLOW ||
              userChoice === USER_CHOICE_ALWAYS_ALLOW;

            if (userChoice === USER_CHOICE_ALWAYS_ALLOW) {
              if (tool_name === BASH_TOOL_NAME && typeof input.command === 'string') {
                await handleBashPrefixApproval(
                  input,
                  allowedToolsMap,
                  true,
                  '',
                  `${BASH_TOOL_NAME} prefix "{prefix}" added to always allowed list`,
                  options.timeout,
                  options.workingDirectory,
                  signal
                );
              } else {
                allowedToolsMap.set(tool_name, true);
                log(chalk.blue(`Tool ${tool_name} added to always allowed list`));
                await addPermissionToFile(tool_name, undefined, options.workingDirectory);
              }
            }

            if (userChoice === USER_CHOICE_SESSION_ALLOW) {
              if (tool_name === BASH_TOOL_NAME && typeof input.command === 'string') {
                await handleBashPrefixApproval(
                  input,
                  allowedToolsMap,
                  false,
                  `${BASH_TOOL_NAME} prefix "{prefix}" added to allowed list for current session only`,
                  '',
                  options.timeout,
                  options.workingDirectory,
                  signal
                );
              } else {
                allowedToolsMap.set(tool_name, true);
                log(chalk.blue(`Tool ${tool_name} added to allowed list for current session only`));
              }
            }
            return promptApproved;
          } catch (error) {
            if (signal.aborted) {
              throw error;
            }
            if (isPromptTimeoutError(error)) {
              const defaultResp = options.defaultResponse ?? 'no';
              log(`\nPermission prompt timed out, using default: ${defaultResp}`);
              return defaultResp === 'yes';
            }
            debugLog('Permission prompt failed with non-timeout error:', error);
            return false;
          }
        },
        options,
        requester,
        message.requestId
      );
    } catch (error) {
      if (isClaudePermissionPromptCancelledError(error)) return;
      approved = false;
      debugLog('Permission prompt coordination failed:', error);
    }

    const response = {
      type: 'permission_response',
      requestId,
      approved,
    };
    writeSocketMessage(socket, response);
  } catch (err) {
    if (isClaudePermissionPromptCancelledError(err)) return;
    debugLog('Permission handler failed:', err);
    const response = {
      type: 'permission_response',
      requestId,
      approved: false,
    };
    writeSocketMessage(socket, response);
  }
}

async function handleAgentToolLine(
  line: string,
  socket: net.Socket,
  context: ClaudeAgentToolContext | undefined
): Promise<void> {
  let rawMessage: unknown;
  try {
    rawMessage = JSON.parse(line);
  } catch (error) {
    debugLog('Failed to parse agent tool request JSON:', error);
    return;
  }

  if (!isRecord(rawMessage) || rawMessage.type !== 'agent_tool_request') return;

  const requestId = getRequestId(rawMessage);
  if (requestId === undefined) {
    debugLog('Agent tool request is missing requestId');
    return;
  }

  const parsed = agentToolRequestSchema.safeParse(rawMessage);
  if (!parsed.success) {
    writeAgentToolError(socket, requestId, 'Agent tool request is invalid');
    return;
  }

  const { tool_name: toolName, input } = parsed.data;
  const roleTools = new Set(
    context === undefined ? [] : getClaudeAgentToolNames(context.caller.role)
  );
  if (context === undefined || !roleTools.has(toolName) || !context.allowedTools.has(toolName)) {
    writeAgentToolError(socket, requestId, `Agent tool ${toolName} is not allowed for this caller`);
    return;
  }

  const validatedInput = getClaudeAgentArgumentSchema(toolName).safeParse(input);
  if (!validatedInput.success) {
    writeAgentToolError(socket, requestId, `Arguments for ${toolName} are invalid`);
    return;
  }

  const caller = callerIdentityFromAgent(context.caller);
  try {
    let result: unknown;
    switch (toolName) {
      case 'StartAgent':
        result = await context.dispatcher.startAgent(caller, validatedInput.data);
        break;
      case 'ListAgents':
        result = await context.dispatcher.listAgents(caller);
        break;
      case 'SendAgentMessage':
        result = await context.dispatcher.sendAgentMessage(caller, validatedInput.data);
        break;
      case 'StopAgent':
        result = await context.dispatcher.stopAgent(caller, validatedInput.data);
        break;
      case 'FinishAgent':
        result = await context.dispatcher.finishAgent(caller, validatedInput.data);
        break;
      default: {
        const exhaustive: never = toolName;
        writeAgentToolError(socket, requestId, `Unknown agent tool ${String(exhaustive)}`);
        return;
      }
    }

    writeSocketMessage(socket, {
      type: 'agent_tool_response',
      requestId,
      success: true,
      result,
    });
  } catch (error) {
    writeAgentToolError(socket, requestId, error);
  }
}

async function handleClaudeMcpLine(
  line: string,
  socket: net.Socket,
  allowedToolsMap: Map<string, true | string[]>,
  requester: { readonly name: string; readonly token: string },
  options: Pick<
    PermissionsMcpOptions,
    | 'defaultResponse'
    | 'timeout'
    | 'autoApproveCreatedFileDeletion'
    | 'trackedFiles'
    | 'workingDirectory'
    | 'interactiveApprovalEnabled'
    | 'permissionPromptCoordinator'
    | 'agentToolContext'
  >
): Promise<void> {
  let rawMessage: unknown;
  try {
    rawMessage = JSON.parse(line);
  } catch (error) {
    debugLog('Failed to parse Claude MCP request JSON:', error);
    return;
  }
  if (!isRecord(rawMessage)) return;

  if (rawMessage.type === 'permission_request') {
    if (options.interactiveApprovalEnabled === false) {
      const requestId = getRequestId(rawMessage);
      if (requestId !== undefined) {
        writeSocketMessage(socket, {
          type: 'permission_response',
          requestId,
          approved: false,
        });
      }
      return;
    }
    await handlePermissionLine(line, socket, allowedToolsMap, requester, options);
    return;
  }

  if (rawMessage.type === 'agent_tool_request') {
    await handleAgentToolLine(line, socket, options.agentToolContext);
  }
}

interface PermissionSocketServerResources {
  readonly server: net.Server;
  readonly sockets: Map<net.Socket, string>;
}

/**
 * Creates a Unix socket server for the generalized tim MCP bridge. The
 * caller context is immutable for the setup and is checked for every tool
 * request; child-side tool visibility is not treated as authorization.
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
    | 'interactiveApprovalEnabled'
    | 'permissionPromptCoordinator'
    | 'agentToolContext'
  >
): Promise<PermissionSocketServerResources> {
  return new Promise((resolve, reject) => {
    const sockets = new Map<net.Socket, string>();
    const server = net.createServer((socket) => {
      const requester = {
        name: getRequesterName(options.agentToolContext) ?? '',
        token: randomUUID(),
      };
      sockets.set(socket, requester.token);
      const splitLines = createBoundedLineSplitter();

      socket.on('data', (data) => {
        let lines: string[];
        try {
          lines = splitLines(data.toString());
        } catch (error) {
          debugLog('Claude MCP client sent an oversized JSON line:', error);
          socket.destroy();
          return;
        }
        for (const line of lines) {
          if (!line) continue;
          void handleClaudeMcpLine(line, socket, allowedToolsMap, requester, options).catch(
            (error) => {
              debugLog('Claude MCP request handler failed:', error);
            }
          );
        }
      });
      socket.on('error', (error) => {
        debugLog('Claude MCP client socket failed:', error);
      });
      const cancelRequester = (): void => {
        if (sockets.delete(socket)) {
          options.permissionPromptCoordinator?.cancelRequester(requester.token);
        }
      };
      socket.on('end', cancelRequester);
      socket.on('close', cancelRequester);
    });

    server.on('error', reject);
    server.listen(socketPath, () => resolve({ server, sockets }));
  });
}

/**
 * Sets up the full permissions MCP infrastructure for a Claude Code subprocess.
 *
 * Creates a temporary directory with:
 * - A Unix socket for permission request handling
 * - An MCP config file pointing to the tim_mcp.ts script
 *
 * Returns the config file path and a cleanup function.
 */
export async function setupPermissionsMcp(
  options: PermissionsMcpOptions
): Promise<PermissionsMcpSetupResult> {
  // Validate and load the user configuration before creating sockets or temp directories.
  const userMcpConfig = await readUserMcpConfig(options.mcpConfigFile);
  assertClaudeMcpServerNameAvailable(userMcpConfig.mcpServers ?? {});

  if (options.agentToolContext !== undefined) {
    validateClaudeAgentToolContext(options.agentToolContext);
  }
  const trustedAgentToolContext: ClaudeAgentToolContext | undefined =
    options.agentToolContext === undefined
      ? undefined
      : {
          caller: Object.freeze({ ...options.agentToolContext.caller }),
          allowedTools: new Set(options.agentToolContext.allowedTools),
          dispatcher: options.agentToolContext.dispatcher,
        };
  const allowedToolsMap = parseAllowedToolsList(options.allowedTools);

  // Create a temporary directory for the MCP config and socket
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-subagent-mcp-'));
  const socketPath = path.join(tempDir, 'permissions.sock');
  const logFile = path.join(tempDir, 'tim-mcp.log');

  let resources: PermissionSocketServerResources | undefined;
  try {
    resources = await createPermissionSocketServer(socketPath, allowedToolsMap, {
      defaultResponse: options.defaultResponse,
      timeout: options.timeout,
      autoApproveCreatedFileDeletion: options.autoApproveCreatedFileDeletion,
      trackedFiles: options.trackedFiles,
      workingDirectory: options.workingDirectory,
      interactiveApprovalEnabled: options.interactiveApprovalEnabled,
      permissionPromptCoordinator: options.permissionPromptCoordinator,
      agentToolContext: trustedAgentToolContext,
    });

    const timMcpPath = await resolvePermissionsMcpPath();
    const childArgs = [timMcpPath, socketPath, logFile];
    if (trustedAgentToolContext !== undefined || options.interactiveApprovalEnabled === false) {
      childArgs.push(
        JSON.stringify({
          interactiveApprovalEnabled: options.interactiveApprovalEnabled !== false,
          agentToolNames: trustedAgentToolContext ? [...trustedAgentToolContext.allowedTools] : [],
        })
      );
    }

    const mcpConfig = mergeClaudeMcpConfig(userMcpConfig, {
      type: 'stdio',
      command: 'bun',
      args: childArgs,
    });

    const mcpConfigFile = path.join(tempDir, 'mcp-config.json');
    const mcpConfigContent = JSON.stringify(mcpConfig, null, 2);
    debugLog('MCP config file content:', mcpConfigContent);
    log(`tim MCP log file: ${logFile}`);
    await fs.writeFile(mcpConfigFile, mcpConfigContent);

    let cleanupPromise: Promise<void> | undefined;
    const cleanup = async (): Promise<void> => {
      cleanupPromise ??= (async (): Promise<void> => {
        for (const [socket, requesterToken] of resources!.sockets) {
          options.permissionPromptCoordinator?.cancelRequester(requesterToken);
          socket.destroy();
        }
        resources!.sockets.clear();
        if (resources!.server.listening) {
          await new Promise<void>((resolve) => resources!.server.close(() => resolve()));
        }
        await fs.rm(tempDir, { recursive: true, force: true });
      })();
      return cleanupPromise;
    };

    return {
      mcpConfigFile,
      tempDir,
      logFile,
      socketServer: resources.server,
      cleanup,
    };
  } catch (error) {
    if (resources !== undefined) {
      for (const [socket, requesterToken] of resources.sockets) {
        options.permissionPromptCoordinator?.cancelRequester(requesterToken);
        socket.destroy();
      }
      resources.sockets.clear();
      if (resources.server.listening) {
        await new Promise<void>((resolve) => resources!.server.close(() => resolve()));
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}
