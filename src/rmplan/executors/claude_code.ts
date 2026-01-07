import { z } from 'zod/v4';
import * as clipboard from '../../common/clipboard.ts';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { debugLog, log } from '../../logging.ts';
import { createLineSplitter, debug, spawnAndLogOutput } from '../../common/process.ts';
import { getGitRoot } from '../../common/git.ts';
import type { PrepareNextStepOptions } from '../plans/prepare_step.ts';
import type { RmplanConfig } from '../configSchema.ts';
import type { Executor, ExecutorCommonOptions, ExecutePlanInfo } from './types.ts';
import { formatJsonMessage } from './claude_code/format.ts';
import { claudeCodeOptionsSchema, ClaudeCodeExecutorName } from './schemas.js';
import chalk from 'chalk';
import * as net from 'net';
import { confirm, select, editor } from '@inquirer/prompts';
import { stringify } from 'yaml';
import { prefixPrompt } from './claude_code/prefix_prompt.ts';
import {
  wrapWithOrchestration,
  wrapWithOrchestrationSimple,
} from './claude_code/orchestrator_prompt.ts';
import { buildAgentsArgument, type AgentDefinition } from './claude_code/agent_generator.ts';
import {
  getImplementerPrompt,
  getVerifierAgentPrompt,
  getTesterPrompt,
  getReviewerPrompt,
} from './claude_code/agent_prompts.ts';
import {
  parseFailedReport,
  parseFailedReportAnywhere,
  detectFailedLineAnywhere,
  inferFailedAgent,
} from './failure_detection.ts';
import { getReviewOutputJsonSchemaString } from '../formatters/review_output_schema.ts';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { readSharedPermissions, addSharedPermission } from '../assignments/permissions_io.js';

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

  /**
   * Load agent instructions from file path, with proper error handling.
   * Returns undefined if the file doesn't exist or can't be read.
   */
  private async loadAgentInstructions(
    instructionPath: string,
    gitRoot: string
  ): Promise<string | undefined> {
    try {
      const resolvedPath = path.isAbsolute(instructionPath)
        ? instructionPath
        : path.join(gitRoot, instructionPath);

      const file = Bun.file(resolvedPath);
      const content = await file.text();
      log(chalk.blue(`📋 Including agent instructions:`), path.relative(gitRoot, resolvedPath));
      return content;
    } catch (error) {
      // Log a warning but don't fail the execution
      debugLog(
        `Warning: Could not load agent instructions from ${instructionPath}: ${error as Error}`
      );
      return undefined;
    }
  }

  constructor(
    public options: ClaudeCodeExecutorOptions,
    public sharedOptions: ExecutorCommonOptions,
    public rmplanConfig: RmplanConfig
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
        await addSharedPermission({
          repositoryId: identity.repositoryId,
          permission: newRule,
          type: 'allow',
        });
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
      const shared = await readSharedPermissions({
        repositoryId: identity.repositoryId,
      });
      return shared.permissions.allow;
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

    // Determine if permissions MCP should be enabled
    let { allowAllTools, mcpConfigFile } = this.options;

    let isPermissionsMcpEnabled = this.options.permissionsMcp?.enabled === true;
    if (process.env.CLAUDE_CODE_MCP) {
      isPermissionsMcpEnabled = process.env.CLAUDE_CODE_MCP === 'true';
    }

    if (allowAllTools == null) {
      const allowAllToolsValue = process.env.ALLOW_ALL_TOOLS ?? 'false';
      const envAllowAllTools = ['true', '1'].includes(allowAllToolsValue.toLowerCase());
      allowAllTools = envAllowAllTools;
    }

    if (allowAllTools || this.sharedOptions.noninteractive) {
      // permissions MCP doesn't make sense in noninteractive mode, or when we want to allow all tools
      isPermissionsMcpEnabled = false;
    }

    // Parse allowedTools for permissions system
    const jsTaskRunners = ['npm', 'pnpm', 'yarn', 'bun'];
    const defaultAllowedTools =
      (this.options.includeDefaultTools ?? true)
        ? [
            `Edit`,
            'MultiEdit',
            `Write`,
            'WebFetch',
            'WebSearch',
            `Bash(cat:*)`,
            `Bash(cd:*)`,
            'Bash(cp:*)',
            'Bash(find:*)',
            'Bash(grep:*)',
            'Bash(ls:*)',
            'Bash(mkdir:*)',
            'Bash(mv:*)',
            'Bash(pwd)',
            'Bash(rg:*)',
            'Bash(sed:*)',
            'Bash(awk:*)',
            'Bash(rm test-:*)',
            'Bash(rm -f test-:*)',
            'Bash(git diff:*)',
            'Bash(git status:*)',
            'Bash(git log:*)',
            'Bash(git commit:*)',
            'Bash(git add:*)',
            'Bash(jj diff:*)',
            'Bash(jj status)',
            'Bash(jj log:*)',
            'Bash(jj commit:*)',
            'Bash(jj bookmark move:*)',
            ...jsTaskRunners.flatMap((name) => [
              `Bash(${name} test:*)`,
              `Bash(${name} run build:*)`,
              `Bash(${name} run check:*)`,
              `Bash(${name} run typecheck:*)`,
              `Bash(${name} run lint:*)`,
              `Bash(${name} install)`,
              `Bash(${name} add:*)`,
            ]),
            'Bash(cargo add:*)',
            'Bash(cargo build)',
            'Bash(cargo test:*)',
            'Bash(rmplan add:*)',
            'Bash(rmplan review:*)',
            'Bash(rmplan set-task-done:*)',
          ]
        : [];

    // Load shared permissions from cross-worktree storage
    const sharedPermissions = await this.loadSharedPermissions();

    let allowedTools = [
      ...defaultAllowedTools,
      ...(this.options.allowedTools ?? []),
      ...sharedPermissions,
    ];
    if (this.options.disallowedTools) {
      allowedTools = allowedTools.filter((t) => !this.options.disallowedTools?.includes(t));
    }

    // Parse allowedTools into efficient lookup structure for auto-approval
    this.parseAllowedTools(allowedTools);

    // Setup permissions MCP if enabled
    let tempMcpConfigDir: string | undefined = undefined;
    let dynamicMcpConfigFile: string | undefined;
    let unixSocketServer: net.Server | undefined;
    let unixSocketPath: string | undefined;

    if (isPermissionsMcpEnabled) {
      // Create a temporary directory
      tempMcpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-mcp-'));

      // Create Unix socket path
      unixSocketPath = path.join(tempMcpConfigDir, 'permissions.sock');

      // Create and start the Unix socket server
      unixSocketServer = await this.createPermissionSocketServer(unixSocketPath);

      // Resolve the absolute path to the permissions MCP script
      let permissionsMcpPath = path.resolve(import.meta.dir, './claude_code/permissions_mcp.ts');
      if (!(await Bun.file(permissionsMcpPath).exists())) {
        permissionsMcpPath = path.resolve(import.meta.dir, './claude_code/permissions_mcp.js');
      }

      // Construct the MCP configuration object with stdio transport
      const permissionsMcpArgs = [permissionsMcpPath, unixSocketPath];

      const mcpConfig = {
        mcpServers: {
          permissions: {
            type: 'stdio',
            command: process.execPath,
            args: permissionsMcpArgs,
          },
        },
      };

      // Write the configuration to a file
      dynamicMcpConfigFile = path.join(tempMcpConfigDir, 'mcp-config.json');
      await Bun.file(dynamicMcpConfigFile).write(JSON.stringify(mcpConfig, null, 2));
    }

    try {
      // Build args for review mode - simpler than full orchestration
      const args = ['claude'];

      // Add MCP config if enabled
      if (isPermissionsMcpEnabled && dynamicMcpConfigFile) {
        args.push('--mcp-config', dynamicMcpConfigFile);
        args.push('--permission-prompt-tool', 'mcp__permissions__approval_prompt');
      } else if (mcpConfigFile) {
        args.push('--mcp-config', mcpConfigFile);
      }

      // Add model selection
      let modelToUse = this.sharedOptions.model;
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

      // Get the JSON schema for structured output
      const jsonSchema = getReviewOutputJsonSchemaString();

      // Use streaming JSON output format with schema for structured parsing
      args.push('--verbose', '--output-format', 'stream-json');
      args.push('--json-schema', jsonSchema);
      args.push(
        '--print',
        contextContent + '\n\nBe sure to provide the structured output with your response'
      );

      let splitter = createLineSplitter();
      let capturedOutput: object | undefined;
      let seenResultMessage = false;

      log(`Interactive permissions MCP is`, isPermissionsMcpEnabled ? 'enabled' : 'disabled');
      const reviewTimeoutMs = 30 * 60 * 1000; // 30 minutes
      let killedByTimeout = false;
      const result = await spawnAndLogOutput(args, {
        env: {
          ...process.env,
          RMPLAN_NOTIFY_SUPPRESS: '1',
          ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
          CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: 'true',
        },
        cwd: gitRoot,
        inactivityTimeoutMs: reviewTimeoutMs,
        initialInactivityTimeoutMs: 2 * 60 * 1000, // 2 minutes to start
        onInactivityKill: () => {
          killedByTimeout = true;
          log(
            `Claude review timed out after ${Math.round(reviewTimeoutMs / 60000)} minutes; terminating.`
          );
        },
        formatStdout: (output) => {
          let lines = splitter(output);
          const formattedResults = lines.map(formatJsonMessage);

          for (const result of formattedResults) {
            if (result.type === 'result') {
              seenResultMessage = true;
            }
            if (result.structuredOutput) {
              if (typeof result.structuredOutput === 'string') {
                capturedOutput = JSON.parse(result.structuredOutput);
              } else {
                capturedOutput = result.structuredOutput;
              }
            }
          }

          const formattedOutput =
            formattedResults.map((r) => r.message || '').join('\n\n') + '\n\n';
          return formattedOutput;
        },
      });

      if ((killedByTimeout || result.killedByInactivity) && !seenResultMessage) {
        throw new Error(
          `Claude review timed out after ${Math.round(reviewTimeoutMs / 60000)} minutes`
        );
      }

      if ((killedByTimeout || result.killedByInactivity) && seenResultMessage) {
        log(
          `Claude review was killed by inactivity timeout, but completed successfully (result message seen)`
        );
      }

      if (result.exitCode !== 0 && !seenResultMessage) {
        throw new Error(`Claude review exited with non-zero exit code: ${result.exitCode}`);
      }

      if (result.exitCode !== 0 && seenResultMessage) {
        log(
          `Claude review exited with code ${result.exitCode}, but completed successfully (result message seen)`
        );
      } else {
        log('Claude review output captured.');
      }

      // Return the captured final message - parsing will happen in createReviewResult()
      return {
        content: '',
        structuredOutput: capturedOutput,
        metadata: { phase: 'review', jsonOutput: true },
      };
    } finally {
      // Close the Unix socket server if it exists
      if (unixSocketServer) {
        await new Promise<void>((resolve) => {
          unixSocketServer.close(() => {
            resolve();
          });
        });
      }

      // Clean up temporary MCP configuration directory if it was created
      if (tempMcpConfigDir) {
        await fs.rm(tempMcpConfigDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Creates a Unix socket server to handle permission requests from the MCP server
   */
  private async createPermissionSocketServer(socketPath: string): Promise<net.Server> {
    const server = net.createServer((socket) => {
      socket.on('data', async (data) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'permission_request') {
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
                      chalk.green(
                        `${BASH_TOOL_NAME} command automatically approved (${approvalSource})`
                      )
                    );
                    const response = {
                      type: 'permission_response',
                      requestId,
                      approved: true,
                    };
                    socket.write(JSON.stringify(response) + '\n');
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
                const response = {
                  type: 'permission_response',
                  requestId,
                  approved: true,
                };
                socket.write(JSON.stringify(response) + '\n');
                return;
              }
            }

            // Check for auto-approval of tracked file deletions
            if (
              this.options.permissionsMcp?.autoApproveCreatedFileDeletion === true &&
              tool_name === BASH_TOOL_NAME
            ) {
              if (typeof input.command !== 'string') {
                // Skip auto-approval logic - let normal permission flow handle it
                // Continue to the existing user prompt logic below
              } else {
                const command = input.command;
                const filePaths = this.parseRmCommand(command);

                if (filePaths.length > 0) {
                  // Check if all file paths are tracked files
                  const allFilesTracked = filePaths.every((filePath) =>
                    this.trackedFiles.has(filePath)
                  );

                  if (allFilesTracked) {
                    log(
                      chalk.green(
                        `Auto-approving rm command for tracked file(s): ${filePaths.join(', ')}`
                      )
                    );
                    const response = {
                      type: 'permission_response',
                      requestId,
                      approved: true,
                    };
                    socket.write(JSON.stringify(response) + '\n');
                    return;
                  }
                }
              }
            }

            // Format the input as human-readable YAML
            let formattedInput = stringify(input);
            if (formattedInput.length > 500) {
              formattedInput = formattedInput.substring(0, 500) + '...';
            }

            // Print BEL character to alert user
            process.stdout.write('\x07');

            // Create a promise that resolves with the default response after timeout
            let promptActive = true;
            const timeoutPromise = this.options.permissionsMcp?.timeout
              ? new Promise<string>((resolve) => {
                  const defaultResponse = this.options.permissionsMcp?.defaultResponse ?? 'no';
                  setTimeout(() => {
                    if (promptActive) {
                      log(`\nPermission prompt timed out, using default: ${defaultResponse}`);
                      resolve(defaultResponse === 'yes' ? 'allow' : 'disallow');
                    }
                  }, this.options.permissionsMcp!.timeout);
                })
              : null;

            // Create an AbortController for the prompt
            const controller = new AbortController();

            // Prompt the user for confirmation
            const promptPromise = select(
              {
                message: `Claude wants to run a tool:\n\nTool: ${chalk.blue(tool_name)}\nInput:\n${chalk.white(formattedInput)}\n\nAllow this tool to run?`,
                choices: [
                  { name: 'Allow', value: USER_CHOICE_ALLOW },
                  { name: 'Allow for Session', value: USER_CHOICE_SESSION_ALLOW },
                  { name: 'Always Allow', value: USER_CHOICE_ALWAYS_ALLOW },
                  { name: 'Disallow', value: USER_CHOICE_DISALLOW },
                ],
              },
              { signal: controller.signal }
            );

            // Race between the prompt and the timeout
            let approved: boolean;
            try {
              let userChoice = await Promise.race(
                [promptPromise, timeoutPromise as Promise<string>].filter(Boolean)
              );
              controller.abort(); // Cancel the prompt if timeout wins
              promptActive = false;

              // Set approved based on the user's choice
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
                  // For non-Bash tools, set the value to true
                  this.alwaysAllowedTools.set(tool_name, true);
                  log(chalk.blue(`Tool ${tool_name} added to always allowed list`));

                  // Save the new permission rule to the settings file
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
                  // For non-Bash tools, set the value to true
                  this.alwaysAllowedTools.set(tool_name, true);
                  log(
                    chalk.blue(`Tool ${tool_name} added to allowed list for current session only`)
                  );
                }

                // NOTE: Deliberately NOT calling addPermissionToFile() for session-only approvals
              }
            } catch (err: any) {
              // If the prompt was aborted (timeout occurred), use the timeout result
              if (err.name === 'AbortPromptError' && this.options.permissionsMcp?.defaultResponse) {
                approved = this.options.permissionsMcp.defaultResponse === 'yes';
                log(
                  chalk.yellow(
                    `Permission prompt timed out. Using default: ${this.options.permissionsMcp.defaultResponse}`
                  )
                );
              } else {
                throw err;
              }
            }

            // Send response back to MCP server
            const response = {
              type: 'permission_response',
              requestId,
              approved,
            };

            socket.write(JSON.stringify(response) + '\n');
          }
        } catch (err) {
          debugLog('Error handling socket message:', err);
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
    contextContent: string,
    planInfo: ExecutePlanInfo
  ): Promise<void | import('./types').ExecutorOutput> {
    // Clear tracked files set for proper state isolation between runs
    this.trackedFiles.clear();

    // Store plan information for use in agent file generation
    this.planInfo = planInfo;

    // Handle review mode with dedicated JSON schema execution path
    if (planInfo.executionMode === 'review') {
      return this.executeReviewMode(contextContent, planInfo);
    }

    let originalContextContent = contextContent;
    const planId = planInfo.planId;
    const planFilePath = planInfo.planFilePath;
    const planContextAvailable = planId.trim().length > 0 && planFilePath.trim().length > 0;

    // In batch mode, prepend the plan file with @ prefix to make it accessible to Edit tool
    if (planInfo && planInfo.batchMode && planInfo.planFilePath) {
      const planFileReference = `${this.filePathPrefix}${planInfo.planFilePath}`;
      contextContent = `${planFileReference}\n\n${contextContent}`;
    }

    // Apply orchestration wrapper when plan information is provided and in normal mode
    if (planContextAvailable) {
      if (planInfo.executionMode === 'normal') {
        contextContent = wrapWithOrchestration(contextContent, planId, {
          batchMode: planInfo.batchMode,
          planFilePath,
          reviewExecutor: this.sharedOptions.reviewExecutor,
        });
      } else if (planInfo.executionMode === 'simple') {
        contextContent = wrapWithOrchestrationSimple(contextContent, planId, {
          batchMode: planInfo.batchMode,
          planFilePath,
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

    const jsTaskRunners = ['npm', 'pnpm', 'yarn', 'bun'];

    const defaultAllowedTools =
      (this.options.includeDefaultTools ?? true)
        ? [
            `Edit`,
            'MultiEdit',
            `Write`,
            'WebFetch',
            'WebSearch',
            `Bash(cat:*)`,
            `Bash(cd:*)`,
            'Bash(cp:*)',
            'Bash(find:*)',
            'Bash(grep:*)',
            'Bash(ls:*)',
            'Bash(mkdir:*)',
            'Bash(mv:*)',
            'Bash(pwd)',
            'Bash(rg:*)',
            'Bash(sed:*)',
            // Allow Claude to delete its own test scripts
            'Bash(rm test-:*)',
            'Bash(rm -f test-:*)',
            'Bash(jj status)',
            'Bash(jj log:*)',
            'Bash(jj commit:*)',
            ...jsTaskRunners.flatMap((name) => [
              `Bash(${name} test:*)`,
              `Bash(${name} run build:*)`,
              `Bash(${name} run check:*)`,
              `Bash(${name} run typecheck:*)`,
              `Bash(${name} run lint:*)`,
              `Bash(${name} install)`,
              `Bash(${name} add:*)`,
            ]),
            'Bash(cargo add:*)',
            'Bash(cargo build)',
            'Bash(cargo test:*)',
            'Bash(rmplan add:*)',
            'Bash(rmplan review:*)',
            'Bash(rmplan set-task-done:*)',
          ]
        : [];

    // Load shared permissions from cross-worktree storage
    const sharedPermissions = await this.loadSharedPermissions();

    let allowedTools = [
      ...defaultAllowedTools,
      ...(this.options.allowedTools ?? []),
      ...sharedPermissions,
    ];
    if (disallowedTools) {
      allowedTools = allowedTools.filter((t) => !disallowedTools?.includes(t));
    }

    // Parse allowedTools into efficient lookup structure for auto-approval
    this.parseAllowedTools(allowedTools);

    // Create temporary MCP configuration if permissions MCP is enabled
    let unixSocketServer: net.Server | undefined;
    let unixSocketPath: string | undefined;

    if (isPermissionsMcpEnabled) {
      // Create a temporary directory
      tempMcpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-mcp-'));

      // Create Unix socket path
      unixSocketPath = path.join(tempMcpConfigDir, 'permissions.sock');

      // Create and start the Unix socket server
      unixSocketServer = await this.createPermissionSocketServer(unixSocketPath);

      // Resolve the absolute path to the permissions MCP script
      let permissionsMcpPath = path.resolve(import.meta.dir, './claude_code/permissions_mcp.ts');
      if (!(await Bun.file(permissionsMcpPath).exists())) {
        permissionsMcpPath = path.resolve(import.meta.dir, './claude_code/permissions_mcp.js');
      }

      // Construct the MCP configuration object with stdio transport
      const permissionsMcpArgs = [permissionsMcpPath, unixSocketPath];

      const mcpConfig = {
        mcpServers: {
          permissions: {
            type: 'stdio',
            command: process.execPath,
            args: permissionsMcpArgs,
          },
        },
      };

      // Write the configuration to a file
      dynamicMcpConfigFile = path.join(tempMcpConfigDir, 'mcp-config.json');
      await Bun.file(dynamicMcpConfigFile).write(JSON.stringify(mcpConfig, null, 2));
    }

    // Build agent definitions when plan information is provided
    let agentDefinitions: AgentDefinition[] | undefined;
    if (planContextAvailable) {
      let agentCreationMessage: string | undefined;

      if (planInfo.executionMode === 'normal') {
        const implementerInstructions = this.rmplanConfig.agents?.implementer?.instructions
          ? await this.loadAgentInstructions(
              this.rmplanConfig.agents.implementer.instructions,
              gitRoot
            )
          : undefined;
        const testerInstructions = this.rmplanConfig.agents?.tester?.instructions
          ? await this.loadAgentInstructions(this.rmplanConfig.agents.tester.instructions, gitRoot)
          : undefined;
        const reviewerInstructions = this.rmplanConfig.agents?.reviewer?.instructions
          ? await this.loadAgentInstructions(
              this.rmplanConfig.agents.reviewer.instructions,
              gitRoot
            )
          : undefined;

        agentDefinitions = [
          getImplementerPrompt(
            originalContextContent,
            planId,
            implementerInstructions,
            this.options.agents?.implementer?.model,
            { mode: 'report' }
          ),
          getTesterPrompt(
            originalContextContent,
            planId,
            testerInstructions,
            this.options.agents?.tester?.model,
            { mode: 'report' }
          ),
          getReviewerPrompt(
            originalContextContent,
            planId,
            reviewerInstructions,
            this.options.agents?.reviewer?.model,
            false,
            false,
            { mode: 'report' }
          ),
        ];
        agentCreationMessage = `Configured implementer/tester/reviewer agents for plan ${planId}`;
      } else if (planInfo.executionMode === 'simple') {
        const implementerInstructions = this.rmplanConfig.agents?.implementer?.instructions
          ? await this.loadAgentInstructions(
              this.rmplanConfig.agents.implementer.instructions,
              gitRoot
            )
          : undefined;
        const testerInstructions = this.rmplanConfig.agents?.tester?.instructions
          ? await this.loadAgentInstructions(this.rmplanConfig.agents.tester.instructions, gitRoot)
          : undefined;
        const reviewerInstructions = this.rmplanConfig.agents?.reviewer?.instructions
          ? await this.loadAgentInstructions(
              this.rmplanConfig.agents.reviewer.instructions,
              gitRoot
            )
          : undefined;
        const verifierInstructions =
          [testerInstructions, reviewerInstructions]
            .filter((instructions): instructions is string => Boolean(instructions?.trim()))
            .join('\n\n') || undefined;

        agentDefinitions = [
          getImplementerPrompt(
            originalContextContent,
            planId,
            implementerInstructions,
            this.options.agents?.implementer?.model,
            { mode: 'report' }
          ),
          getVerifierAgentPrompt(
            originalContextContent,
            planId,
            verifierInstructions,
            this.options.agents?.tester?.model,
            false,
            false,
            { mode: 'report' }
          ),
        ];
        agentCreationMessage = `Configured implementer/verifier agents for plan ${planId}`;
      }
      // 'bare', 'planning', and 'review' modes: skip agent definitions entirely
    }

    try {
      const args = ['claude'];

      const extraAccessDirs = new Set<string>();
      if (
        this.rmplanConfig.isUsingExternalStorage &&
        this.rmplanConfig.externalRepositoryConfigDir
      ) {
        extraAccessDirs.add(this.rmplanConfig.externalRepositoryConfigDir);
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

      // Add agents argument if agent definitions were created
      if (agentDefinitions && agentDefinitions.length > 0) {
        for (const def of agentDefinitions) {
          if (!def.model) {
            def.model = DEFAULT_CLAUDE_MODEL;
          }
        }

        args.push('--agents', buildAgentsArgument(agentDefinitions));
      }

      if (debug) {
        args.push('--debug');
      }

      args.push('--verbose', '--output-format', 'stream-json', '--print', contextContent);
      let splitter = createLineSplitter();
      let capturedOutputLines: string[] = [];
      let lastAssistantRaw: string | undefined;
      let failureSummary: string | undefined;
      let failureRaw: string | undefined;
      let seenResultMessage = false;

      log(`Interactive permissions MCP is`, isPermissionsMcpEnabled ? 'enabled' : 'disabled');
      const executionTimeoutMs = 60 * 60 * 1000; // 60 minutes
      let killedByTimeout = false;
      const result = await spawnAndLogOutput(args, {
        env: {
          ...process.env,
          RMPLAN_NOTIFY_SUPPRESS: '1',
          ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
          CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: 'true',
        },
        cwd: gitRoot,
        inactivityTimeoutMs: executionTimeoutMs,
        initialInactivityTimeoutMs: 2 * 60 * 1000, // 2 minutes to start
        onInactivityKill: () => {
          killedByTimeout = true;
          log(
            `Claude execution timed out after ${Math.round(executionTimeoutMs / 60000)} minutes of inactivity; terminating.`
          );
        },
        formatStdout: (output) => {
          let lines = splitter(output);
          const formattedResults = lines.map(formatJsonMessage);
          // Capture output based on the specified mode
          const captureMode = planInfo?.captureOutput;

          // Extract file paths and add them to trackedFiles set
          for (const result of formattedResults) {
            if (result.type === 'result') {
              seenResultMessage = true;
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
                capturedOutputLines.push(result.message);
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

          const formattedOutput =
            formattedResults.map((r) => r.message || '').join('\n\n') + '\n\n';
          return formattedOutput;
        },
      });

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
      // Close the Unix socket server if it exists
      if (unixSocketServer) {
        await new Promise<void>((resolve) => {
          unixSocketServer.close(() => {
            resolve();
          });
        });
      }

      // Clean up temporary MCP configuration directory if it was created
      if (tempMcpConfigDir) {
        await fs.rm(tempMcpConfigDir, { recursive: true, force: true });
      }
    }
  }
}
