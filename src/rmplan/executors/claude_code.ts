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
  private trackedFiles = new Set<string>();
  private planInfo?: ExecutePlanInfo;

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
      if (toolName === 'Bash' && argument) {
        if (argument.exact) {
          newRule = `Bash(${argument.command})`;
        } else {
          newRule = `Bash(${argument.command}:*)`;
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
              if (tool_name === 'Bash' && Array.isArray(allowedValue)) {
                const command = input.command as string;
                const isAllowed = allowedValue.some((prefix) => command.startsWith(prefix));

                if (isAllowed) {
                  const approvalSource = this.configAllowedTools.has('Bash') 
                    ? 'configured in allowlist' 
                    : 'always allowed';
                  log(chalk.green(`Bash command automatically approved (${approvalSource})`));
                  const response = {
                    type: 'permission_response',
                    approved: true,
                  };
                  socket.write(JSON.stringify(response) + '\n');
                  return;
                }
              } else if (allowedValue === true) {
                const approvalSource = this.configAllowedTools.has(tool_name) 
                  ? 'configured in allowlist' 
                  : 'always allowed';
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
              tool_name === 'Bash'
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
                  { name: 'Allow', value: 'allow' },
                  { name: 'Disallow', value: 'disallow' },
                  { name: 'Always Allow', value: 'always_allow' },
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
              approved = userChoice === 'allow' || userChoice === 'always_allow';

              // If user chose "Always Allow", add the tool to the always allowed set
              if (userChoice === 'always_allow') {
                let prefixForBash: { exact: boolean; command: string } | undefined;

                if (tool_name === 'Bash') {
                  // For Bash tool, prompt for a prefix to allow
                  const command = input.command as string;
                  const selectedPrefix = await prefixPrompt({
                    message: 'Select the command prefix to always allow:',
                    command: command,
                  });

                  prefixForBash = selectedPrefix;

                  // Add the prefix to the array of allowed prefixes for Bash
                  const existingPrefixes = this.alwaysAllowedTools.get('Bash') as
                    | string[]
                    | undefined;
                  if (existingPrefixes) {
                    existingPrefixes.push(selectedPrefix.command);
                  } else {
                    this.alwaysAllowedTools.set('Bash', [selectedPrefix.command]);
                  }
                  log(
                    chalk.blue(
                      `Bash prefix "${selectedPrefix.command}" added to always allowed list`
                    )
                  );
                } else {
                  // For non-Bash tools, set the value to true
                  this.alwaysAllowedTools.set(tool_name, true);
                  log(chalk.blue(`Tool ${tool_name} added to always allowed list`));
                }

                // Save the new permission rule to the settings file
                await this.addPermissionToFile(tool_name, prefixForBash);
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

  async execute(contextContent: string, planInfo: ExecutePlanInfo) {
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

    // Apply orchestration wrapper when plan information is provided
    if (planInfo && planInfo.planId) {
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
    this.alwaysAllowedTools.clear(); // Clear any existing session-based entries
    this.configAllowedTools.clear(); // Clear any existing config entries tracking
    for (const tool of allowedTools) {
      if (tool.startsWith('Bash(') && tool.endsWith(')')) {
        // Handle Bash command patterns like "Bash(jj commit:*)" or "Bash(pwd)"
        const bashCommand = tool.slice(5, -1); // Remove "Bash(" and ")"
        
        let commandPrefix: string;
        if (bashCommand.endsWith(':*')) {
          // Wildcard pattern - extract the prefix
          commandPrefix = bashCommand.slice(0, -2);
        } else {
          // Exact match - use the full command
          commandPrefix = bashCommand;
        }

        // Add to the array of allowed Bash prefixes
        const existingPrefixes = this.alwaysAllowedTools.get('Bash') as string[] | undefined;
        if (existingPrefixes) {
          existingPrefixes.push(commandPrefix);
        } else {
          this.alwaysAllowedTools.set('Bash', [commandPrefix]);
        }
        this.configAllowedTools.add('Bash'); // Track that Bash was configured
      } else {
        // Simple tool name like "Edit", "Write", etc.
        this.alwaysAllowedTools.set(tool, true);
        this.configAllowedTools.add(tool); // Track that this tool was configured
      }
    }

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

    // Generate agent files if plan information is provided
    if (planInfo && planInfo.planId) {
      const agentDefinitions = [
        getImplementerPrompt(originalContextContent),
        getTesterPrompt(originalContextContent),
        getReviewerPrompt(originalContextContent),
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

        log(`Interactive permissions MCP is`, isPermissionsMcpEnabled ? 'enabled' : 'disabled');
        const result = await spawnAndLogOutput(args, {
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
          },
          cwd: gitRoot,
          formatStdout: (output) => {
            let lines = splitter(output);
            const formattedResults = lines.map(formatJsonMessage);

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
            }

            return formattedResults.map((r) => r.message || '').join('\n\n') + '\n\n';
          },
        });

        if (result.exitCode !== 0) {
          throw new Error(`Claude exited with non-zero exit code: ${result.exitCode}`);
        }
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

      // Clean up agent files if they were created
      if (planInfo && planInfo.planId) {
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
