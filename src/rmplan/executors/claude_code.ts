import { z } from 'zod/v4';
import * as clipboard from '../../common/clipboard.ts';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { debugLog, log } from '../../logging.ts';
import { createLineSplitter, debug, spawnAndLogOutput } from '../../common/process.ts';
import { getGitRoot } from '../../common/git.ts';
import type { PrepareNextStepOptions } from '../actions.ts';
import type { RmplanConfig } from '../configSchema.ts';
import type { Executor, ExecutorCommonOptions } from './types.ts';
import { formatJsonMessage } from './claude_code/format.ts';
import { claudeCodeOptionsSchema, ClaudeCodeExecutorName } from './schemas.js';
import chalk from 'chalk';
import * as net from 'net';
import { confirm } from '@inquirer/prompts';
import { stringify } from 'yaml';

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

  constructor(
    public options: ClaudeCodeExecutorOptions,
    public sharedOptions: ExecutorCommonOptions,
    public rmplanConfig: RmplanConfig
  ) {}

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

            // Format the input as human-readable YAML
            let formattedInput = stringify(input);
            if (formattedInput.length > 500) {
              formattedInput = formattedInput.substring(0, 500) + '...';
            }

            // Print BEL character to alert user
            process.stdout.write('\x07');

            let approved: boolean;

            // Create a promise that resolves with the default response after timeout
            const timeoutPromise = this.options.permissionsMcp?.timeout
              ? new Promise<boolean>((resolve) => {
                  const defaultResponse = this.options.permissionsMcp?.defaultResponse ?? 'no';
                  setTimeout(() => {
                    log(`Permission prompt timed out, using default: ${defaultResponse}`);
                    resolve(defaultResponse === 'yes');
                  }, this.options.permissionsMcp!.timeout);
                })
              : new Promise<boolean>(() => {}); // Never resolves if no timeout

            // Create an AbortController for the prompt
            const controller = new AbortController();

            // Prompt the user for confirmation
            const promptPromise = confirm(
              {
                message: `Claude wants to run a tool:\n\nTool: ${chalk.blue(tool_name)}\nInput:\n${chalk.white(formattedInput)}\n\nAllow this tool to run?`,
              },
              { signal: controller.signal }
            );

            // Race between the prompt and the timeout
            try {
              approved = await Promise.race([promptPromise, timeoutPromise]);
              controller.abort(); // Cancel the prompt if timeout wins
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

  async execute(contextContent: string) {
    let { disallowedTools, allowAllTools, mcpConfigFile, interactive } = this.options;

    // TODO Interactive mode isn't integrated with the logging
    interactive ??= (process.env.CLAUDE_INTERACTIVE ?? 'false') === 'true';

    let isPermissionsMcpEnabled = this.options.permissionsMcp?.enabled === true;
    if (process.env.CLAUDE_CODE_MCP) {
      isPermissionsMcpEnabled = process.env.CLAUDE_CODE_MCP === 'true';
    }

    if (interactive) {
      // permissions MCP doesn't make sense in interactive mode
      isPermissionsMcpEnabled = false;
    }

    let tempMcpConfigDir: string | undefined = undefined;
    let dynamicMcpConfigFile: string | undefined;

    allowAllTools ??= (process.env.ALLOW_ALL_TOOLS ?? 'false') === 'true';

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

    try {
      const args = ['claude'];

      if (!interactive) {
        args.push('--verbose', '--output-format', 'stream-json');

        if (debug) {
          args.push('--debug');
        }
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

      if (
        this.sharedOptions.model?.includes('haiku') ||
        this.sharedOptions.model?.includes('sonnet') ||
        this.sharedOptions.model?.includes('opus')
      ) {
        log(`Using model: ${this.sharedOptions.model}\n`);
        args.push('--model', this.sharedOptions.model);
      }

      if (interactive) {
        await clipboard.write(contextContent);
        log(chalk.green(`Copied prompt to clipboard to paste into Claude`));

        // In interactive mode, use Bun.spawn directly with inherited stdio
        debugLog(args);
        const proc = Bun.spawn(args, {
          cwd: await getGitRoot(),
          stdio: ['inherit', 'inherit', 'inherit'],
        });

        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          throw new Error(`Claude exited with non-zero exit code: ${exitCode}`);
        }
      } else {
        args.push('--print', contextContent);
        let splitter = createLineSplitter();

        log(`Interactive permissions MCP is`, isPermissionsMcpEnabled ? 'enabled' : 'disabled');
        const result = await spawnAndLogOutput(args, {
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
          },
          cwd: await getGitRoot(),
          formatStdout: (output) => {
            let lines = splitter(output);
            return lines.map(formatJsonMessage).join('\n\n') + '\n\n';
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
    }
  }
}
