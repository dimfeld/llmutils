import { z } from 'zod';
import type { RmplanConfig } from '../configSchema.ts';
import type { Executor, AgentCommandSharedOptions } from './types.ts';
import type { PrepareNextStepOptions } from '../actions.ts';
import { getGitRoot, logSpawn, spawnAndLogOutput } from '../../rmfilter/utils.ts';

const claudeCodeOptionsSchema = z.object({
  allowedTools: z.array(z.string()).optional(),
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
    const { allowedTools, disallowedTools, mcpConfigFile } = this.options;
    const args = ['claude', '-p', contextContent];

    if (allowedTools) {
      args.push('--allowedTools', allowedTools.join(','));
    }
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
