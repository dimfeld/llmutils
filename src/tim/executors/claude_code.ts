import { z } from 'zod/v4';
import * as clipboard from '../../common/clipboard.ts';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { debugLog, log, sendStructured, error } from '../../logging.ts';
import { createLineSplitter, debug, spawnWithStreamingIO } from '../../common/process.ts';
import { getGitRoot } from '../../common/git.ts';
import type { PrepareNextStepOptions } from '../plans/prepare_step.ts';
import type { TimConfig } from '../configSchema.ts';
import type { Executor, ExecutorCommonOptions, ExecutePlanInfo } from './types.ts';
import {
  extractStructuredMessages,
  formatJsonMessage,
  resetToolUseCache,
} from './claude_code/format.ts';
import { claudeCodeOptionsSchema, ClaudeCodeExecutorName } from './schemas.js';
import chalk from 'chalk';
import * as net from 'net';
import { promptSelect, isPromptTimeoutError } from '../../common/input.ts';
import { stringify } from 'yaml';
import stripAnsi from 'strip-ansi';
import { prefixPrompt } from './claude_code/prefix_prompt.ts';
import {
  wrapWithOrchestration,
  wrapWithOrchestrationSimple,
  wrapWithOrchestrationTdd,
} from './claude_code/orchestrator_prompt.ts';
import {
  parseFailedReport,
  parseFailedReportAnywhere,
  detectFailedLineAnywhere,
  inferFailedAgent,
} from './failure_detection.ts';
import { getReviewOutputJsonSchemaString } from '../formatters/review_output_schema.ts';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { addPermission, getPermissions } from '../db/permission.js';
import { getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { createTunnelServer, type TunnelServer } from '../../logging/tunnel_server.js';
import { createPromptRequestHandler } from '../../logging/tunnel_prompt_handler.js';
import { TIM_OUTPUT_SOCKET } from '../../logging/tunnel_protocol.js';
import { setupPermissionsMcp } from './claude_code/permissions_mcp_setup.js';
import { runClaudeSubprocess, buildAllowedToolsList } from './claude_code/run_claude_subprocess.js';
import { executeWithTerminalInput } from './claude_code/terminal_input_lifecycle.ts';

export type ClaudeCodeExecutorOptions = z.infer<typeof claudeCodeOptionsSchema>;

// Constants for magic strings
const BASH_TOOL_NAME = 'Bash';
const USER_CHOICE_ALLOW = 'allow';
const USER_CHOICE_ALWAYS_ALLOW = 'always_allow';
const USER_CHOICE_SESSION_ALLOW = 'session_allow';
const USER_CHOICE_DISALLOW = 'disallow';

const DEFAULT_CLAUDE_MODEL = 'opus';

export class ClaudeCodeExecutor implements Executor {
  static name = ClaudeCodeExecutorName;
  static description = 'Executes the plan using Claude Code';
  static optionsSchema = claudeCodeOptionsSchema;
  static defaultModel = {
    execution: 'auto',
    answerPr: 'auto',
  };
  static supportsSubagents = true;
  readonly supportsSubagents = true;

  // readonly forceReviewCommentsMode = 'separate-context';
  readonly filePathPrefix = '@';
  readonly todoDirections = '- Use the TodoWrite tool to maintain your TODO list.';
  private alwaysAllowedTools = new Map<string, true | string[]>();
  private configAllowedTools = new Set<string>();
  private configToolsInitialized = false;

  /**
   * Parse the allowedTools configuration into efficient lookup structures for auto-approval.
   * This method is exposed for testing purposes.
   */
  private parseAllowedTools(allowedTools: string[]): void {
    // Only initialize config-based tools once to avoid clearing session-based approvals
    if (!this.configToolsInitialized) {
      this.configAllowedTools.clear(); // Only clear config tracking, not session data

      for (const tool of allowedTools) {
        // Input validation for malformed tool strings
        if (typeof tool !== 'string' || tool.trim() === '') {
          debugLog(`Skipping invalid tool configuration: ${tool}`);
          continue;
        }

        const trimmedTool = tool.trim();

        if (trimmedTool.startsWith(`${BASH_TOOL_NAME}(`)) {
          // Validate Bash command format
          if (!trimmedTool.endsWith(')')) {
            debugLog(
              `Skipping malformed Bash tool configuration: ${trimmedTool} (missing closing parenthesis)`
            );
            continue;
          }

          // Handle Bash command patterns like "Bash(jj commit:*)" or "Bash(pwd)"
          const bashCommand = trimmedTool.slice(5, -1); // Remove "Bash(" and ")"

          // Validate bash command is not empty
          if (bashCommand.trim() === '') {
            debugLog(`Skipping empty Bash command configuration: ${trimmedTool}`);
            continue;
          }

          let commandPrefix: string;
          if (bashCommand.endsWith(':*')) {
            // Wildcard pattern - extract the prefix
            commandPrefix = bashCommand.slice(0, -2).trim();
            if (commandPrefix === '') {
              debugLog(`Skipping empty Bash command prefix: ${trimmedTool}`);
              continue;
            }
          } else {
            // Exact match - use the full command
            commandPrefix = bashCommand.trim();
          }

          // Use safe method to add prefix (prevents duplicates and type safety issues)
          this.addBashPrefixSafely(commandPrefix);

          this.configAllowedTools.add(BASH_TOOL_NAME); // Track that Bash was configured
        } else {
          // Simple tool name like "Edit", "Write", etc.
          // Only set if not already session-approved
          if (!this.alwaysAllowedTools.has(trimmedTool)) {
            this.alwaysAllowedTools.set(trimmedTool, true);
          }
          this.configAllowedTools.add(trimmedTool); // Track that this tool was configured
        }
      }

      this.configToolsInitialized = true;
    }
  }

  /**
   * Test helper method to trigger parsing of allowedTools configuration.
   * This method is only used for testing purposes.
   */
  public testParseAllowedTools(allowedTools: string[]): void {
    // Reset initialization state to allow re-parsing for tests
    this.configToolsInitialized = false;
    this.parseAllowedTools(allowedTools);
  }

  /**
   * Test helper method to access the parsed allowedTools data structures.
   * This method is only used for testing purposes.
   */
  public testGetParsedAllowedTools(): {
    alwaysAllowedTools: Map<string, true | string[]>;
    configAllowedTools: Set<string>;
  } {
    return {
      alwaysAllowedTools: new Map(this.alwaysAllowedTools),
      configAllowedTools: new Set(this.configAllowedTools),
    };
  }
  private trackedFiles = new Set<string>();
  private planInfo?: ExecutePlanInfo;

  constructor(
    public options: ClaudeCodeExecutorOptions,
    public sharedOptions: ExecutorCommonOptions,
    public timConfig: TimConfig
  ) {}

  /**
   * Parses an rm command to extract file paths and normalize them to absolute paths.
   * Handles various rm command formats including flags and quoted paths.
   *
   * @param command - The bash command string to parse
   * @returns Array of absolute file paths that would be deleted, or empty array if not an rm command
   */
  private parseRmCommand(command: string): string[] {
    const trimmedCommand = command.trim();

    // Match rm commands - ensure it starts with 'rm' as a complete word
    if (!trimmedCommand.match(/^rm(\s|$)/)) {
      return [];
    }

    // Split the command into tokens while preserving quoted strings
    const tokens = this.parseCommandTokens(trimmedCommand);

    if (tokens.length === 0 || tokens[0] !== 'rm') {
      return [];
    }

    // Filter out the 'rm' command and any flags to get just the file paths
    const filePaths: string[] = [];

    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];

      // Skip flags (starting with - or --)
      if (token.startsWith('-')) {
        continue;
      }

      filePaths.push(token);
    }

    // Normalize paths to absolute paths
    const normalizedPaths: string[] = [];
    for (const pathStr of filePaths) {
      // Skip empty paths
      if (!pathStr.trim()) {
        continue;
      }

      // Skip wildcard patterns or complex shell expansions for safety
      if (pathStr.includes('*') || pathStr.includes('?') || pathStr.includes('[')) {
        continue;
      }

      // Convert to absolute path
      let absolutePath: string;
      if (path.isAbsolute(pathStr)) {
        absolutePath = pathStr;
      } else {
        // Use the current working directory (assume it's the git root for this context)
        // In a real scenario, we might need to track the actual cwd from the bash session
        absolutePath = path.resolve(process.cwd(), pathStr);
      }

      normalizedPaths.push(absolutePath);
    }

    return normalizedPaths;
  }

  /**
   * Parses command tokens while handling quotes and escaping properly.
   *
   * @param command - The command string to parse
   * @returns Array of tokens
   */
  private parseCommandTokens(command: string): string[] {
    const tokens: string[] = [];
    let currentToken = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escaped = false;

    for (let i = 0; i < command.length; i++) {
      const char = command[i];

      if (escaped) {
        currentToken += char;
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        currentToken += char;
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

      if (!inSingleQuote && !inDoubleQuote && /\s/.test(char)) {
        // We've hit whitespace outside of quotes - end of current token
        if (currentToken.trim()) {
          tokens.push(currentToken.trim());
          currentToken = '';
        }
        continue;
      }

      currentToken += char;
    }

    // Add the final token if there is one
    if (currentToken.trim()) {
      tokens.push(currentToken.trim());
    }

    return tokens;
  }

  /**
   * Safely validates that the value for Bash tool is an array and adds a prefix to it.
   * This prevents type safety violations and duplicate entries.
   * @param prefix - The command prefix to add
   * @returns true if the prefix was added, false if it was already present
   */
  private addBashPrefixSafely(prefix: string): boolean {
    const existingValue = this.alwaysAllowedTools.get(BASH_TOOL_NAME);

    // Type safety validation
    if (existingValue !== undefined && !Array.isArray(existingValue) && existingValue !== true) {
      // This should not happen, but if it does, we need to handle it gracefully
      debugLog(
        `Warning: Unexpected value type for ${BASH_TOOL_NAME} in alwaysAllowedTools: ${typeof existingValue}`
      );
      // Reset to empty array to continue safely
      this.alwaysAllowedTools.set(BASH_TOOL_NAME, [prefix]);
      return true;
    }

    if (Array.isArray(existingValue)) {
      // Prevent duplicates
      if (!existingValue.includes(prefix)) {
        existingValue.push(prefix);
        return true;
      }
      return false; // Already exists
    } else if (existingValue === undefined) {
      // No existing entries, create new array
      this.alwaysAllowedTools.set(BASH_TOOL_NAME, [prefix]);
      return true;
    }

    // existingValue === true means Bash was already approved for all commands
    // No need to add specific prefixes in this case
    return false;
  }

  /**
   * Handles Bash command prefix approval logic shared between always_allow and session_allow.
   * @param input - The tool input containing the command
   * @param isPersistent - Whether this should be persisted to settings file
   * @param sessionMessage - Message to display for session approvals
   * @param persistentMessage - Message to display for persistent approvals
   */
  private async handleBashPrefixApproval(
    input: any,
    isPersistent: boolean,
    sessionMessage: string,
    persistentMessage: string
  ): Promise<void> {
    try {
      const command = input.command as string;
      const selectedPrefix = await prefixPrompt({
        message: isPersistent
          ? 'Select the command prefix to always allow:'
          : 'Select the command prefix to allow for this session:',
        command: command,
      });

      // Add the prefix using the safe method
      const wasAdded = this.addBashPrefixSafely(selectedPrefix.command);

      if (wasAdded) {
        const message = isPersistent ? persistentMessage : sessionMessage;
        log(chalk.blue(message.replace('{prefix}', selectedPrefix.command)));
      } else {
        // Prefix was already present
        log(
          chalk.yellow(`Bash prefix "${selectedPrefix.command}" was already in the allowed list`)
        );
      }

      // Save to settings file only for persistent approvals
      if (isPersistent) {
        await this.addPermissionToFile(BASH_TOOL_NAME, selectedPrefix);
      }
    } catch (error) {
      debugLog(`Error handling Bash prefix approval: ${error as Error}`);
      throw error; // Re-throw to let caller handle appropriately
    }
  }

  /**
   * Adds a new permission rule to the Claude settings file
   */
  private async addPermissionToFile(
    toolName: string,
    argument?: { exact: boolean; command?: string }
  ): Promise<void> {
    try {
      const gitRoot = await getGitRoot();
      const settingsPath = path.join(gitRoot, '.claude', 'settings.local.json');

      // Try to read existing settings
      let settings: any = {};
      try {
        const settingsContent = await fs.readFile(settingsPath, 'utf-8');
        settings = JSON.parse(settingsContent);
      } catch (err) {
        // File doesn't exist or can't be parsed - start with defaults
        settings = {
          permissions: {
            allow: [],
            deny: [],
          },
        };
      }

      // Ensure permissions structure exists
      settings.permissions ??= { allow: [], deny: [] };
      settings.permissions.allow ??= [];

      // Add the new permission rule
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

      // Only add if it doesn't already exist
      if (!settings.permissions.allow.includes(newRule)) {
        settings.permissions.allow.push(newRule);

        // Ensure directory exists
        const settingsDir = path.dirname(settingsPath);
        await fs.mkdir(settingsDir, { recursive: true });

        // Write the settings back to file
        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
      }

      // Also save to shared permissions for cross-worktree sharing
      try {
        const identity = await getRepositoryIdentity();
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

  prepareStepOptions(): Partial<PrepareNextStepOptions> {
    return {
      rmfilter: false,
      model: 'claude',
    };
  }

  /**
   * Loads shared permissions from cross-worktree storage.
   * Returns an array of permission strings to be added to allowedTools.
   */
  private async loadSharedPermissions(): Promise<string[]> {
    try {
      const identity = await getRepositoryIdentity();
      const db = getDatabase();
      const project = getOrCreateProject(db, identity.repositoryId, {
        remoteUrl: identity.remoteUrl,
      });
      const permissions = getPermissions(db, project.id);
      return permissions.allow;
    } catch (err) {
      debugLog('Could not load shared permissions:', err);
      return [];
    }
  }

  /**
   * Executes a review-mode prompt using structured JSON output.
   * This bypasses the full orchestration workflow and uses Claude's JSON schema
   * output format for reliable parsing of review results.
   */
  private async executeReviewMode(
    contextContent: string,
    planInfo: ExecutePlanInfo
  ): Promise<import('./types').ExecutorOutput> {
    const gitRoot = await getGitRoot();

    log('Running Claude in review mode with JSON schema output...');

    // Parse allowedTools into efficient lookup structure for auto-approval
    const sharedPermissions = await this.loadSharedPermissions();
    const allowedTools = buildAllowedToolsList({
      includeDefaultTools: this.options.includeDefaultTools,
      configAllowedTools: this.options.allowedTools,
      disallowedTools: this.options.disallowedTools,
      sharedPermissions,
    });
    this.parseAllowedTools(allowedTools);

    const jsonSchema = getReviewOutputJsonSchemaString();
    let capturedOutput: object | undefined;

    const reviewTimeoutMs = 30 * 60 * 1000; // 30 minutes
    const result = await runClaudeSubprocess({
      prompt: contextContent + '\n\nBe sure to provide the structured output with your response',
      cwd: gitRoot,
      claudeCodeOptions: this.options,
      noninteractive: this.sharedOptions.noninteractive ?? false,
      terminalInput: this.sharedOptions.terminalInput,
      model: this.sharedOptions.model,
      label: 'review',
      inactivityTimeoutMs: reviewTimeoutMs,
      extraArgs: ['--json-schema', jsonSchema],
      extraAccessDirs:
        this.timConfig.isUsingExternalStorage && this.timConfig.externalRepositoryConfigDir
          ? [this.timConfig.externalRepositoryConfigDir]
          : undefined,
      trackedFiles: this.trackedFiles,
      createPermissionSocketServer: (socketPath) => this.createPermissionSocketServer(socketPath),
      logModelSelection: true,
      processFormattedMessages: (messages) => {
        for (const r of messages) {
          if (r.structuredOutput) {
            if (typeof r.structuredOutput === 'string') {
              capturedOutput = JSON.parse(r.structuredOutput);
            } else {
              capturedOutput = r.structuredOutput as object;
            }
          }
        }
      },
    });

    if ((result.killedByTimeout || result.killedByInactivity) && !result.seenResultMessage) {
      throw new Error(
        `Claude review timed out after ${Math.round(reviewTimeoutMs / 60000)} minutes`
      );
    }

    if ((result.killedByTimeout || result.killedByInactivity) && result.seenResultMessage) {
      log(
        `Claude review was killed by inactivity timeout, but completed successfully (result message seen)`
      );
    }

    if (result.exitCode !== 0 && !result.seenResultMessage) {
      throw new Error(`Claude review exited with non-zero exit code: ${result.exitCode}`);
    }

    if (result.exitCode !== 0 && result.seenResultMessage) {
      log(
        `Claude review exited with code ${result.exitCode}, but completed successfully (result message seen)`
      );
    } else {
      log('Claude review output captured.');
    }

    return {
      content: '',
      structuredOutput: capturedOutput,
      metadata: { phase: 'review', jsonOutput: true },
    };
  }

  /**
   * Creates a Unix socket server to handle permission requests from the MCP server
   */
  private async handlePermissionMessage(line: string, socket: net.Socket): Promise<void> {
    try {
      const message = JSON.parse(line);

      if (message.type !== 'permission_request') {
        return;
      }

      const { requestId, tool_name, input } = message;

      // Check if this tool is already in the always allowed set
      const allowedValue = this.alwaysAllowedTools.get(tool_name);
      if (allowedValue !== undefined) {
        // For Bash tools, check if the command matches any allowed prefix
        if (tool_name === BASH_TOOL_NAME && Array.isArray(allowedValue)) {
          // Safely validate input.command is a string before using string methods
          if (typeof input.command === 'string') {
            const command = input.command;
            const isAllowed = allowedValue.some((prefix) => command.startsWith(prefix));

            if (isAllowed) {
              const approvalSource = this.configAllowedTools.has(BASH_TOOL_NAME)
                ? 'configured in allowlist'
                : 'always allowed (session)';
              log(
                chalk.green(`${BASH_TOOL_NAME} command automatically approved (${approvalSource})`)
              );
              socket.write(
                JSON.stringify({ type: 'permission_response', requestId, approved: true }) + '\n'
              );
              return;
            }
          }
          // If input.command is not a string or doesn't match any allowed prefix,
          // fall through to normal permission prompt
        } else if (allowedValue === true) {
          const approvalSource = this.configAllowedTools.has(tool_name)
            ? 'configured in allowlist'
            : 'always allowed (session)';
          log(chalk.green(`Tool ${tool_name} automatically approved (${approvalSource})`));
          socket.write(
            JSON.stringify({ type: 'permission_response', requestId, approved: true }) + '\n'
          );
          return;
        }
      }

      // Check for auto-approval of tracked file deletions
      if (
        this.options.permissionsMcp?.autoApproveCreatedFileDeletion === true &&
        tool_name === BASH_TOOL_NAME &&
        typeof input.command === 'string'
      ) {
        const filePaths = this.parseRmCommand(input.command);

        if (filePaths.length > 0) {
          const allFilesTracked = filePaths.every((filePath) => this.trackedFiles.has(filePath));

          if (allFilesTracked) {
            log(
              chalk.green(`Auto-approving rm command for tracked file(s): ${filePaths.join(', ')}`)
            );
            socket.write(
              JSON.stringify({ type: 'permission_response', requestId, approved: true }) + '\n'
            );
            return;
          }
        }
      }

      // Format the input as human-readable YAML
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
            { name: 'Allow', value: USER_CHOICE_ALLOW },
            { name: 'Allow for Session', value: USER_CHOICE_SESSION_ALLOW },
            { name: 'Always Allow', value: USER_CHOICE_ALWAYS_ALLOW },
            { name: 'Disallow', value: USER_CHOICE_DISALLOW },
          ],
          timeoutMs: this.options.permissionsMcp?.timeout,
        });

        approved =
          userChoice === USER_CHOICE_ALLOW ||
          userChoice === USER_CHOICE_ALWAYS_ALLOW ||
          userChoice === USER_CHOICE_SESSION_ALLOW;

        // If user chose "Always Allow", add the tool to the always allowed set
        if (userChoice === USER_CHOICE_ALWAYS_ALLOW) {
          if (tool_name === BASH_TOOL_NAME) {
            await this.handleBashPrefixApproval(
              input,
              true, // isPersistent
              '', // sessionMessage (not used for persistent)
              `${BASH_TOOL_NAME} prefix "{prefix}" added to always allowed list`
            );
          } else {
            this.alwaysAllowedTools.set(tool_name, true);
            log(chalk.blue(`Tool ${tool_name} added to always allowed list`));
            await this.addPermissionToFile(tool_name);
          }
        }

        // If user chose "Allow for Session", add the tool to the always allowed set without persistence
        if (userChoice === USER_CHOICE_SESSION_ALLOW) {
          if (tool_name === BASH_TOOL_NAME) {
            await this.handleBashPrefixApproval(
              input,
              false, // isPersistent (session-only)
              `${BASH_TOOL_NAME} prefix "{prefix}" added to allowed list for current session only`,
              '' // persistentMessage (not used for session)
            );
          } else {
            this.alwaysAllowedTools.set(tool_name, true);
            log(chalk.blue(`Tool ${tool_name} added to allowed list for current session only`));
          }
        }
      } catch (err) {
        if (isPromptTimeoutError(err)) {
          const defaultResp = this.options.permissionsMcp?.defaultResponse ?? 'no';
          approved = defaultResp === 'yes';
          log(`\nPermission prompt timed out, using default: ${defaultResp}`);
        } else {
          // Transport error, tunnel disconnect, or unexpected failure - deny for safety
          approved = false;
          debugLog('Permission prompt failed with non-timeout error:', err);
        }
      }

      socket.write(JSON.stringify({ type: 'permission_response', requestId, approved }) + '\n');
    } catch (err) {
      debugLog('Error handling permission request:', err);
    }
  }

  /**
   * Creates a Unix socket server to handle permission requests from the MCP server
   */
  private async createPermissionSocketServer(socketPath: string): Promise<net.Server> {
    const server = net.createServer((socket) => {
      const splitLines = createLineSplitter();

      socket.on('data', (data) => {
        const lines = splitLines(data.toString());
        for (const line of lines) {
          if (!line) continue;
          void this.handlePermissionMessage(line, socket);
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(socketPath, () => {
        resolve();
      });
      server.on('error', reject);
    });

    return server;
  }

  async execute(
    contextContent: string | undefined,
    planInfo: ExecutePlanInfo
  ): Promise<void | import('./types').ExecutorOutput> {
    // Clear tracked files set for proper state isolation between runs
    this.trackedFiles.clear();

    // Store plan information for use in agent file generation
    this.planInfo = planInfo;

    // Handle review mode with dedicated JSON schema execution path
    if (planInfo.executionMode === 'review') {
      if (contextContent == null) {
        throw new Error('Prompt content is required for review mode');
      }
      return this.executeReviewMode(contextContent, planInfo);
    }

    let promptContent = contextContent;

    const planId = planInfo.planId;
    const planFilePath = planInfo.planFilePath;
    const planContextAvailable = planId.trim().length > 0 && planFilePath.trim().length > 0;

    // In batch mode, prepend the plan file with @ prefix to make it accessible to Edit tool
    if (planInfo && planInfo.batchMode && planInfo.planFilePath && promptContent != null) {
      const planFileReference = `${this.filePathPrefix}${planInfo.planFilePath}`;
      promptContent = `${planFileReference}\n\n${promptContent}`;
    }

    // Apply orchestration wrapper when plan information is provided and in normal mode
    if (planContextAvailable && promptContent != null) {
      if (planInfo.executionMode === 'normal') {
        promptContent = wrapWithOrchestration(promptContent, planId, {
          batchMode: planInfo.batchMode,
          planFilePath,
          reviewExecutor: this.sharedOptions.reviewExecutor,
          subagentExecutor: this.sharedOptions.subagentExecutor,
          dynamicSubagentInstructions: this.sharedOptions.dynamicSubagentInstructions,
        });
      } else if (planInfo.executionMode === 'simple') {
        promptContent = wrapWithOrchestrationSimple(promptContent, planId, {
          batchMode: planInfo.batchMode,
          planFilePath,
          subagentExecutor: this.sharedOptions.subagentExecutor,
          dynamicSubagentInstructions: this.sharedOptions.dynamicSubagentInstructions,
        });
      } else if (planInfo.executionMode === 'tdd') {
        promptContent = wrapWithOrchestrationTdd(promptContent, planId, {
          batchMode: planInfo.batchMode,
          planFilePath,
          simpleMode: this.sharedOptions.simpleMode,
          reviewExecutor: this.sharedOptions.reviewExecutor,
          subagentExecutor: this.sharedOptions.subagentExecutor,
          dynamicSubagentInstructions: this.sharedOptions.dynamicSubagentInstructions,
        });
      }
    }

    let { disallowedTools, allowAllTools, mcpConfigFile } = this.options;

    // Get git root for agent instructions and other operations
    const gitRoot = await getGitRoot();

    let isPermissionsMcpEnabled = this.options.permissionsMcp?.enabled === true;
    if (process.env.CLAUDE_CODE_MCP) {
      isPermissionsMcpEnabled = process.env.CLAUDE_CODE_MCP === 'true';
    }

    if (allowAllTools == null) {
      const allowAllToolsValue = process.env.ALLOW_ALL_TOOLS ?? 'false';
      const envAllowAllTools = ['true', '1'].includes(allowAllToolsValue.toLowerCase());
      allowAllTools = envAllowAllTools;
    }

    if (this.sharedOptions.noninteractive) {
      // permissions MCP doesn't make sense in noninteractive mode
      isPermissionsMcpEnabled = false;
    }

    let tempMcpConfigDir: string | undefined = undefined;
    let dynamicMcpConfigFile: string | undefined;
    let permissionsMcpCleanup: (() => Promise<void>) | undefined;

    // Load shared permissions from cross-worktree storage
    const sharedPermissions = await this.loadSharedPermissions();

    let allowedTools = buildAllowedToolsList({
      includeDefaultTools: this.options.includeDefaultTools,
      configAllowedTools: this.options.allowedTools,
      disallowedTools,
      sharedPermissions,
    });

    // Parse allowedTools into efficient lookup structure for auto-approval
    this.parseAllowedTools(allowedTools);

    if (isPermissionsMcpEnabled) {
      const result = await setupPermissionsMcp({
        allowedTools,
        defaultResponse: this.options.permissionsMcp?.defaultResponse,
        timeout: this.options.permissionsMcp?.timeout,
        autoApproveCreatedFileDeletion: this.options.permissionsMcp?.autoApproveCreatedFileDeletion,
        trackedFiles: this.trackedFiles,
        workingDirectory: gitRoot,
        createSocketServer: (socketPath) => this.createPermissionSocketServer(socketPath),
      });
      tempMcpConfigDir = result.tempDir;
      dynamicMcpConfigFile = result.mcpConfigFile;
      permissionsMcpCleanup = result.cleanup;
    }

    // Create tunnel server for output forwarding from child processes
    let tunnelServer: TunnelServer | undefined;
    const tunnelTempDir =
      tempMcpConfigDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'tim-tunnel-')));
    const tunnelSocketPath = path.join(tunnelTempDir, 'output.sock');
    if (!isTunnelActive()) {
      try {
        const promptHandler = createPromptRequestHandler();
        tunnelServer = await createTunnelServer(tunnelSocketPath, {
          onPromptRequest: promptHandler,
        });
      } catch (err) {
        debugLog('Could not create tunnel server for output forwarding:', err);
      }
    }

    // Agent definitions (--agents flag) are no longer used in normal/simple orchestration modes.
    // The orchestrator prompt references `tim subagent` Bash commands instead.
    // Other modes (bare, planning, review) also don't use agent definitions.

    let terminalInputResult: ReturnType<typeof executeWithTerminalInput> | undefined;
    try {
      const args = ['claude'];

      const extraAccessDirs = new Set<string>();
      if (this.timConfig.isUsingExternalStorage && this.timConfig.externalRepositoryConfigDir) {
        extraAccessDirs.add(this.timConfig.externalRepositoryConfigDir);
      }

      for (const dir of extraAccessDirs) {
        args.push('--add-dir', dir);
      }

      if (allowedTools.length) {
        args.push('--allowedTools', allowedTools.join(','));
      }

      if (allowAllTools) {
        args.push('--dangerously-skip-permissions');
      }

      if (disallowedTools) {
        args.push('--disallowedTools', disallowedTools.join(','));
      }

      if (isPermissionsMcpEnabled && dynamicMcpConfigFile) {
        args.push('--mcp-config', dynamicMcpConfigFile);
        args.push('--permission-prompt-tool', 'mcp__permissions__approval_prompt');
      } else if (mcpConfigFile) {
        args.push('--mcp-config', mcpConfigFile);
      }

      // Automatic model selection for review and planning modes
      let modelToUse = this.sharedOptions.model;
      // Sonnet is good enough now we dont really need opus anymore
      // if (
      //   (planInfo.executionMode === 'review' || planInfo.executionMode === 'planning') &&
      //   !modelToUse
      // ) {
      //   modelToUse = 'opus';
      // }

      if (
        modelToUse?.includes('haiku') ||
        modelToUse?.includes('sonnet') ||
        modelToUse?.includes('opus')
      ) {
        log(`Using model: ${modelToUse}\n`);
        args.push('--model', modelToUse);
      } else {
        log(`Using default model: ${DEFAULT_CLAUDE_MODEL}\n`);
        args.push('--model', DEFAULT_CLAUDE_MODEL);
      }

      if (debug) {
        args.push('--debug');
      }

      args.push('--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json');
      let splitter = createLineSplitter();
      let capturedOutputLines: string[] = [];
      let lastAssistantRaw: string | undefined;
      let failureSummary: string | undefined;
      let failureRaw: string | undefined;
      let seenResultMessage = false;

      log(`Interactive permissions MCP is`, isPermissionsMcpEnabled ? 'enabled' : 'disabled');
      const disableInactivityTimeout = this.sharedOptions.disableInactivityTimeout === true;
      const executionTimeoutMs = 60 * 60 * 1000; // 60 minutes
      let killedByTimeout = false;
      resetToolUseCache();
      const streaming = await spawnWithStreamingIO(args, {
        env: {
          ...process.env,
          CLAUDECODE: '',
          TIM_EXECUTOR: 'claude',
          TIM_NOTIFY_SUPPRESS: '1',
          ...(tunnelServer ? { [TIM_OUTPUT_SOCKET]: tunnelSocketPath } : {}),
          ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
          CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: 'true',
        },
        cwd: gitRoot,
        inactivityTimeoutMs: disableInactivityTimeout ? undefined : executionTimeoutMs,
        initialInactivityTimeoutMs: disableInactivityTimeout ? undefined : 2 * 60 * 1000,
        onInactivityKill: () => {
          killedByTimeout = true;
          log(
            `Claude execution timed out after ${Math.round(executionTimeoutMs / 60000)} minutes of inactivity; terminating.`
          );
        },
        formatStdout: (output) => {
          let lines = splitter(output);
          const formattedResults = lines.map(formatJsonMessage);
          const structuredMessages = extractStructuredMessages(formattedResults);
          // Capture output based on the specified mode
          const captureMode = planInfo?.captureOutput;

          // Extract file paths and add them to trackedFiles set
          for (const result of formattedResults) {
            if (result.type === 'result') {
              seenResultMessage = true;
              terminalInputResult?.onResultMessage();
            }
            if (result.filePaths) {
              for (const filePath of result.filePaths) {
                // Resolve to absolute path
                const absolutePath = path.isAbsolute(filePath)
                  ? filePath
                  : path.resolve(gitRoot, filePath);
                this.trackedFiles.add(absolutePath);
              }
            }

            if (result.message) {
              if (captureMode === 'all') {
                capturedOutputLines.push(result.rawMessage ?? stripAnsi(result.message));
              } else if (
                captureMode === 'result' &&
                result.type === 'assistant' &&
                result.rawMessage
              ) {
                // Only save the final message
                capturedOutputLines = [result.rawMessage];
              }
            }
            if (result.type === 'assistant' && result.rawMessage) {
              lastAssistantRaw = result.rawMessage;
            }
            if (result.failed && result.rawMessage) {
              failureSummary = result.failedSummary || 'Agent reported FAILED';
              failureRaw = result.rawMessage;
            }
          }

          return structuredMessages.length > 0 ? structuredMessages : '';
        },
      });

      terminalInputResult = executeWithTerminalInput({
        streaming,
        prompt: promptContent,
        sendStructured,
        debugLog,
        errorLog: error,
        log,
        label: 'execution',
        tunnelServer,
        terminalInputEnabled: this.sharedOptions.terminalInput === true,
        tunnelForwardingEnabled: isTunnelActive(),
        closeOnResultMessage: this.sharedOptions.closeTerminalInputOnResult ?? true,
      });

      const result = await terminalInputResult.resultPromise;

      if ((killedByTimeout || result.killedByInactivity) && !seenResultMessage) {
        throw new Error(
          `Claude execution timed out after ${Math.round(executionTimeoutMs / 60000)} minutes of inactivity`
        );
      }

      if ((killedByTimeout || result.killedByInactivity) && seenResultMessage) {
        log(
          `Claude execution was killed by inactivity timeout, but completed successfully (result message seen)`
        );
      }

      if (result.exitCode !== 0 && !seenResultMessage) {
        throw new Error(`Claude exited with non-zero exit code: ${result.exitCode}`);
      }

      if (result.exitCode !== 0 && seenResultMessage) {
        log(
          `Claude exited with code ${result.exitCode}, but completed successfully (result message seen)`
        );
      }

      // Determine failure from stream if not already captured
      if (!failureRaw && lastAssistantRaw) {
        const parsed = parseFailedReportAnywhere(lastAssistantRaw);
        if (parsed.failed) {
          failureRaw = lastAssistantRaw;
          failureSummary = parsed.summary || 'Agent reported FAILED';
        }
      }

      // If a failure was detected at any point, return structured failure regardless of capture mode
      if (failureRaw) {
        const parsedAny = parseFailedReportAnywhere(failureRaw);
        const failedLine = detectFailedLineAnywhere(failureRaw);
        const sourceAgent = inferFailedAgent(
          failedLine.failed ? failedLine.summary : undefined,
          failureRaw
        );

        return {
          content: failureRaw,
          metadata: { phase: 'orchestrator' },
          success: false,
          failureDetails:
            parsedAny.failed && parsedAny.details
              ? { ...parsedAny.details, sourceAgent }
              : { requirements: '', problems: failureSummary || 'FAILED', sourceAgent },
        };
      }

      // Return captured output if any capture mode was enabled, otherwise return void explicitly
      const captureMode = planInfo?.captureOutput;
      if (captureMode === 'all' || captureMode === 'result') {
        return {
          content: capturedOutputLines.join('\n\n'),
          metadata: { phase: 'orchestrator' },
        };
      }

      return; // Explicitly return void for 'none' or undefined captureOutput
    } finally {
      terminalInputResult?.cleanup();

      // Close the tunnel server if it was created
      tunnelServer?.close();

      if (permissionsMcpCleanup) {
        await permissionsMcpCleanup();
      }

      // Clean up tunnel temp directory if we created a separate one
      if (!tempMcpConfigDir) {
        await fs.rm(tunnelTempDir, { recursive: true, force: true });
      }
    }
  }
}
