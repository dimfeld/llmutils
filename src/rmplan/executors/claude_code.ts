import { z } from 'zod/v4';
import * as clipboard from '../../common/clipboard.ts';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'node:fs';
import { debugLog, log } from '../../logging.ts';
import { CleanupRegistry } from '../../common/cleanup_registry.ts';
import { createLineSplitter, debug, spawnAndLogOutput } from '../../common/process.ts';
import { getGitRoot } from '../../common/git.ts';
import type { PrepareNextStepOptions } from '../plans/prepare_step.ts';
import type { RmplanConfig } from '../configSchema.ts';
import type { Executor, ExecutorCommonOptions, ExecutePlanInfo } from './types.ts';
import { formatJsonMessage } from './claude_code/format.ts';
import { claudeCodeOptionsSchema, ClaudeCodeExecutorName } from './schemas.js';
import chalk from 'chalk';
import * as net from 'net';
import { confirm, select } from '@inquirer/prompts';
import { stringify } from 'yaml';
import { prefixPrompt } from './claude_code/prefix_prompt.ts';
import { waitForEnter } from '../../common/terminal.ts';
import { wrapWithOrchestration } from './claude_code/orchestrator_prompt.ts';
import { generateAgentFiles, removeAgentFiles } from './claude_code/agent_generator.ts';
import {
  getImplementerPrompt,
  getTesterPrompt,
  getReviewerPrompt,
} from './claude_code/agent_prompts.ts';

export type ClaudeCodeExecutorOptions = z.infer<typeof claudeCodeOptionsSchema>;

// Constants for magic strings
const BASH_TOOL_NAME = 'Bash';
const USER_CHOICE_ALLOW = 'allow';
const USER_CHOICE_ALWAYS_ALLOW = 'always_allow';
const USER_CHOICE_SESSION_ALLOW = 'session_allow';
const USER_CHOICE_DISALLOW = 'disallow';

export class ClaudeCodeExecutor implements Executor {
  static name = ClaudeCodeExecutorName;
  static description = 'Executes the plan using Claude Code';
  static optionsSchema = claudeCodeOptionsSchema;
  static defaultModel = {
    execution: 'auto',
    answerPr: 'auto',
  };

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
    } catch (err) {
      debugLog('Could not save permission to Claude settings:', err);
    }
  }

  prepareStepOptions(): Partial<PrepareNextStepOptions> {
    return {
      rmfilter: false,
      model: 'claude',
      // run all steps in a task since Claude code has its own TODO lists for these things and can more efficiently
      // handle them together.
      selectSteps: 'all',
    };
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
            const { tool_name, input } = message;

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
              approved,
            };

            socket.write(JSON.stringify(response) + '\n');
          }
        } catch (err) {
          debugLog('Error handling permission request:', err);
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

  async execute(contextContent: string, planInfo: ExecutePlanInfo): Promise<void | string> {
    // Clear tracked files set for proper state isolation between runs
    this.trackedFiles.clear();

    // Store plan information for use in agent file generation
    this.planInfo = planInfo;

    let originalContextContent = contextContent;

    // In batch mode, prepend the plan file with @ prefix to make it accessible to Edit tool
    if (planInfo && planInfo.batchMode && planInfo.planFilePath) {
      const planFileReference = `${this.filePathPrefix}${planInfo.planFilePath}`;
      contextContent = `${planFileReference}\n\n${contextContent}`;
    }

    // Apply orchestration wrapper when plan information is provided and NOT in simple mode
    if (planInfo && planInfo.planId && planInfo.executionMode !== 'simple') {
      contextContent = wrapWithOrchestration(contextContent, planInfo.planId, {
        batchMode: planInfo.batchMode,
        planFilePath: planInfo.planFilePath,
      });
    }

    let { disallowedTools, allowAllTools, mcpConfigFile, interactive } = this.options;
    let unregisterCleanup: (() => void) | undefined;

    // Get git root early since we'll need it for cleanup handler
    const gitRoot = await getGitRoot();

    // TODO Interactive mode isn't integrated with the logging
    interactive ??= this.sharedOptions.interactive;
    interactive ??= (process.env.CLAUDE_INTERACTIVE ?? 'false') === 'true';

    let isPermissionsMcpEnabled = this.options.permissionsMcp?.enabled === true;
    if (process.env.CLAUDE_CODE_MCP) {
      isPermissionsMcpEnabled = process.env.CLAUDE_CODE_MCP === 'true';
    }

    if (allowAllTools == null) {
      const allowAllToolsValue = process.env.ALLOW_ALL_TOOLS ?? 'false';
      const envAllowAllTools = ['true', '1'].includes(allowAllToolsValue.toLowerCase());
      allowAllTools = envAllowAllTools;
    }

    if (interactive || allowAllTools) {
      // permissions MCP doesn't make sense in interactive mode, or when we want to allow all tools
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
          ]
        : [];

    let allowedTools = [...defaultAllowedTools, ...(this.options.allowedTools ?? [])];
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
      const mcpConfig = {
        mcpServers: {
          permissions: {
            type: 'stdio',
            command: process.execPath,
            args: [permissionsMcpPath, unixSocketPath],
          },
        },
      };

      // Write the configuration to a file
      dynamicMcpConfigFile = path.join(tempMcpConfigDir, 'mcp-config.json');
      await Bun.file(dynamicMcpConfigFile).write(JSON.stringify(mcpConfig, null, 2));
    }

    // Generate agent files if plan information is provided and NOT in simple mode
    if (planInfo && planInfo.planId && planInfo.executionMode !== 'simple') {
      // Load custom instructions for each agent if configured
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
        ? await this.loadAgentInstructions(this.rmplanConfig.agents.reviewer.instructions, gitRoot)
        : undefined;

      const agentDefinitions = [
        getImplementerPrompt(originalContextContent, implementerInstructions),
        getTesterPrompt(originalContextContent, testerInstructions),
        getReviewerPrompt(originalContextContent, reviewerInstructions),
      ];
      await generateAgentFiles(planInfo.planId, agentDefinitions);
      log(chalk.blue(`Created agent files for plan ${planInfo.planId}`));

      // Register cleanup handler for agent files
      const cleanupRegistry = CleanupRegistry.getInstance();
      unregisterCleanup = cleanupRegistry.register(() => {
        try {
          const agentsDir = path.join(gitRoot, '.claude', 'agents');

          // Use synchronous operations since this may be called from signal handlers
          try {
            const files = fsSync.readdirSync(agentsDir);
            const matchingFiles = files.filter((file) =>
              file.match(new RegExp(`^rmplan-${planInfo.planId}-.*\\.md$`))
            );

            for (const file of matchingFiles) {
              const filePath = path.join(agentsDir, file);
              try {
                fsSync.unlinkSync(filePath);
              } catch (err) {
                console.error(`Failed to remove agent file ${filePath}:`, err);
              }
            }
          } catch (err) {
            // Directory might not exist
            debugLog('Error reading agents directory during cleanup:', err);
          }
        } catch (err) {
          debugLog('Error during agent file cleanup:', err);
        }
      });
    }

    try {
      const args = ['claude'];

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

      if (
        this.sharedOptions.model?.includes('haiku') ||
        this.sharedOptions.model?.includes('sonnet') ||
        this.sharedOptions.model?.includes('opus')
      ) {
        log(`Using model: ${this.sharedOptions.model}\n`);
        args.push('--model', this.sharedOptions.model);
      } else {
        log('Using default model: sonnet\n');
        args.push('--model', 'sonnet');
      }

      if (interactive) {
        await clipboard.writeClipboardAndWait(
          chalk.green('Copied prompt to clipboard.') +
            '\nPlease start `claude` in a separate terminal window and paste the prompt into it, then press Enter here when you are done.',

          contextContent
        );

        // This is broken right now due to issues with Bun apparently not closing readline appropriately
        // Probably related: https://github.com/oven-sh/bun/issues/13978 and https://github.com/oven-sh/bun/issues/10694
        /*
        // In interactive mode, use Bun.spawn directly with inherited stdio
        debugLog(args);
        const proc = Bun.spawn(args, {
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
          },
          cwd: gitRoot,
          stdio: ['inherit', 'inherit', 'inherit'],
        });

        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          throw new Error(`Claude exited with non-zero exit code: ${exitCode}`);
        }
        */
      } else {
        if (debug) {
          args.push('--debug');
        }

        args.push('--verbose', '--output-format', 'stream-json', '--print', contextContent);
        let splitter = createLineSplitter();
        const capturedOutputLines: string[] = [];

        log(`Interactive permissions MCP is`, isPermissionsMcpEnabled ? 'enabled' : 'disabled');
        const result = await spawnAndLogOutput(args, {
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.CLAUDE_API_KEY ?? '') : '',
          },
          cwd: gitRoot,
          formatStdout: (output) => {
            let lines = splitter(output);
            const formattedResults = lines.map(formatJsonMessage);
            // Capture output based on the specified mode
            const captureMode = planInfo?.captureOutput;

            // Extract file paths and add them to trackedFiles set
            for (const result of formattedResults) {
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
                } else if (captureMode === 'result' && result.type === 'result') {
                  capturedOutputLines.push(result.message);
                }
              }
            }

            const formattedOutput =
              formattedResults.map((r) => r.message || '').join('\n\n') + '\n\n';
            return formattedOutput;
          },
        });

        if (result.exitCode !== 0) {
          throw new Error(`Claude exited with non-zero exit code: ${result.exitCode}`);
        }

        // Return captured output if any capture mode was enabled, otherwise return void explicitly
        const captureMode = planInfo?.captureOutput;
        if (captureMode === 'all' || captureMode === 'result') {
          return capturedOutputLines.join('');
        }

        return; // Explicitly return void for 'none' or undefined captureOutput
      }
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

      // Clean up agent files if they were created (only in normal mode)
      if (planInfo && planInfo.planId && planInfo.executionMode !== 'simple') {
        await removeAgentFiles(planInfo.planId);
        debugLog(`Removed agent files for plan ${planInfo.planId}`);
      }

      // Unregister the cleanup handler since we've cleaned up normally
      if (unregisterCleanup) {
        unregisterCleanup();
      }
    }
  }
}
