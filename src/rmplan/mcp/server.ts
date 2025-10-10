import { FastMCP } from 'fastmcp';
import { registerGenerateMode, type GenerateModeRegistrationContext } from './generate_mode.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanPathContext } from '../path_resolver.js';

export type SupportedMcpMode = 'generate';

export interface StartMcpServerOptions {
  mode?: SupportedMcpMode;
  configPath?: string;
  transport?: 'stdio' | 'http';
  port?: number;
}

export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<void> {
  const mode = options.mode ?? 'generate';
  if (mode !== 'generate') {
    throw new Error(`Unsupported MCP mode: ${mode as string}`);
  }

  const config = await loadEffectiveConfig(options.configPath);
  const pathContext = await resolvePlanPathContext(config);

  const server = new FastMCP({
    name: 'rmplan',
    version: '0.1.0',
    instructions:
      'rmplan MCP server exposing interactive plan generation helpers. Use the prompts to gather context and tools to update plans.',
  });

  const registrationContext: GenerateModeRegistrationContext = {
    config,
    configPath: options.configPath,
    gitRoot: pathContext.gitRoot,
  };

  registerGenerateMode(server, registrationContext);

  if (options.transport === 'http') {
    const port = options.port ?? 0;
    await server.start({
      transportType: 'httpStream',
      httpStream: {
        port,
      },
    });
  } else {
    await server.start({ transportType: 'stdio' });
  }
}
