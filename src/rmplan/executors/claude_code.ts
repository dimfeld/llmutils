import { z } from 'zod';
import type { RmplanConfig } from '../configSchema.ts';
import type { Executor, AgentCommandSharedOptions } from './types.ts';
import type { PrepareNextStepOptions } from '../actions.ts';
import { debug, getGitRoot, logSpawn, spawnAndLogOutput } from '../../rmfilter/utils.ts';

const claudeCodeOptionsSchema = z.object({
  allowedTools: z.array(z.string()).optional(),
  includeDefaultTools: z.boolean().default(true),
  disallowedTools: z.array(z.string()).optional(),
  mcpConfigFile: z.string().optional(),
});

export type ClaudeCodeExecutorOptions = z.infer<typeof claudeCodeOptionsSchema>;

export class ClaudeCodeExecutor implements Executor {
  static name = 'claude-code';
  static description = 'Executes the plan using Claude Code';
  static optionsSchema = claudeCodeOptionsSchema;

  constructor(
    public options: ClaudeCodeExecutorOptions,
    public sharedOptions: AgentCommandSharedOptions,
    public rmplanConfig: RmplanConfig
  ) {}

  prepareStepOptions(): Partial<PrepareNextStepOptions> {
    return {
      rmfilter: false,
      model: 'claude',
    };
  }

  async execute(contextContent: string) {
    const { disallowedTools, mcpConfigFile } = this.options;
    const gitRoot = await getGitRoot();

    const jsTaskRunners = ['npm', 'pnpm', 'yarn', 'bun'];

    const defaultAllowedTools = this.options.includeDefaultTools
      ? [
          `Edit(${gitRoot})`,
          `Write(${gitRoot})`,
          'WebFetch',
          ...jsTaskRunners.flatMap((name) => [
            `Bash(${name} test:*)`,
            `Bash(${name} run build:*)`,
            `Bash(${name} install)`,
            `Bash(${name} add)`,
          ]),
          'Bash(cargo add)',
          'Bash(cargo build)',
          'Bash(cargo test)',
        ]
      : [];

    let allowedTools = [...defaultAllowedTools, ...(this.options.allowedTools ?? [])];
    if (disallowedTools) {
      allowedTools = allowedTools.filter((t) => !disallowedTools?.includes(t));
    }

    const args = [
      'claude',
      '-p',
      debug ? '--debug' : '',
      '--allowedTools',
      allowedTools.join('n'),
      contextContent,
    ].filter(Boolean);

    if (disallowedTools) {
      args.push('--disallowedTools', disallowedTools.join(','));
    }
    if (mcpConfigFile) {
      args.push('--mcp-config', mcpConfigFile);
    }

    await spawnAndLogOutput(args, {
      cwd: await getGitRoot(),
    });
  }
}
