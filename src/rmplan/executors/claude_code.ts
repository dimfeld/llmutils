import { z } from 'zod/v4';
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

const claudeCodeOptionsSchema = z.object({
  allowedTools: z.array(z.string()).optional(),
  allowAllTools: z.boolean().optional(),
  includeDefaultTools: z.boolean().default(true),
  disallowedTools: z.array(z.string()).optional(),
  mcpConfigFile: z.string().optional(),
  interactive: z.boolean().optional(),
  enablePermissionsMcp: z.boolean().optional(),
});

export type ClaudeCodeExecutorOptions = z.infer<typeof claudeCodeOptionsSchema>;

export const ClaudeCodeExecutorName = 'claude-code';

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
    const isPermissionsMcpEnabled =
      enablePermissionsMcp === true || process.env.CLAUDE_CODE_MCP === 'true';

    let tempMcpConfigDir: string | undefined = undefined;
    let dynamicMcpConfigFile: string | undefined;

    allowAllTools ??= (process.env.ALLOW_ALL_TOOLS ?? 'false') === 'true';
    // TODO Interactive mode needs some work. It's not taking the prompt right away
    // Also it isn't integrated with the logging
    interactive ??= (process.env.CLAUDE_INTERACTIVE ?? 'false') === 'true';

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
    if (isPermissionsMcpEnabled) {
      // Create a temporary directory
      tempMcpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-mcp-'));

      // Resolve the absolute path to the permissions MCP script
      const permissionsMcpPath = Bun.resolveSync(
        './claude_code/permissions_mcp.ts',
        import.meta.dir
      );

      // Construct the MCP configuration object
      const mcpConfig = {
        mcpServers: {
          permissions: {
            command: 'bun',
            args: [permissionsMcpPath],
          },
        },
      };

      // Write the configuration to a file
      dynamicMcpConfigFile = path.join(tempMcpConfigDir, 'mcp-config.json');
      await fs.writeFile(dynamicMcpConfigFile, JSON.stringify(mcpConfig, null, 2));
    }

    const args = ['claude'];

    if (!interactive) {
      args.push('--verbose', '--output-format', 'stream-json');
    }

    if (debug && !interactive) {
      args.push('--debug');
    }

    args.push('--allowedTools', allowedTools.join(','));

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

    if (!interactive) {
      args.push('-p');
    }

    args.push(contextContent);

    if (interactive) {
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
      let splitter = createLineSplitter();

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
  }
}
