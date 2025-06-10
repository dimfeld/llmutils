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

  async execute(contextContent: string) {
    let { disallowedTools, allowAllTools, mcpConfigFile, interactive, enablePermissionsMcp } =
      this.options;

    // TODO Interactive mode isn't integrated with the logging
    interactive ??= (process.env.CLAUDE_INTERACTIVE ?? 'false') === 'true';

    let isPermissionsMcpEnabled = enablePermissionsMcp === true;
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

    const defaultAllowedTools = this.options.includeDefaultTools
      ? [
          `Edit`,
          'MultiEdit',
          `Write`,
          'WebFetch',
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
    let mcpServerProcess: ReturnType<typeof Bun.spawn> | undefined;

    if (isPermissionsMcpEnabled) {
      // Create a temporary directory
      tempMcpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-mcp-'));

      // Resolve the absolute path to the permissions MCP script
      const permissionsMcpPath = Bun.resolveSync(
        './claude_code/permissions_mcp.ts',
        import.meta.dir
      );

      // Create a promise to wait for the port number from the MCP server
      const portPromise = Promise.withResolvers<number>();

      // Spawn the MCP server process
      mcpServerProcess = Bun.spawn([process.execPath, permissionsMcpPath], {
        stdio: ['inherit', 'inherit', 'inherit'],
        ipc(message) {
          if (message && typeof message === 'object' && 'port' in message) {
            portPromise.resolve(message.port);
          }
        },
      });

      // Wait for the port with a timeout
      const port = await Promise.race([
        portPromise.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('MCP server startup timeout')), 5000)
        ),
      ]);

      // Construct the MCP configuration object with SSE transport
      const mcpConfig = {
        mcpServers: {
          permissions: {
            type: 'sse',
            url: `http://localhost:${port}/sse`,
          },
        },
      };

      // Write the configuration to a file
      dynamicMcpConfigFile = path.join(tempMcpConfigDir, 'mcp-config.json');
      await fs.writeFile(dynamicMcpConfigFile, JSON.stringify(mcpConfig, null, 2));
    }

    try {
      const args = ['claude'];

      if (!interactive) {
        args.push('--verbose', '--output-format', 'stream-json', '--print');

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
        args.push(contextContent);
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
      // Kill the spawned MCP server process if it exists
      if (mcpServerProcess) {
        mcpServerProcess.kill();
      }

      // Clean up temporary MCP configuration directory if it was created
      if (tempMcpConfigDir) {
        await fs.rm(tempMcpConfigDir, { recursive: true, force: true });
      }
    }
  }
}
