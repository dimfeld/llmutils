import { z, ZodError, type ZodTypeAny } from 'zod/v4';
import { writeStderr, writeStdout } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanPathContext } from '../path_resolver.js';
import {
  createPlanParameters,
  createPlanTool,
  generateTasksParameters,
  getPlanParameters,
  getPlanTool,
  listReadyPlansParameters,
  listReadyPlansTool,
  managePlanTaskParameters,
  managePlanTaskTool,
  updatePlanDetailsParameters,
  updatePlanDetailsTool,
  updatePlanTasksTool,
  type ToolContext,
  type ToolResult,
} from '../tools/index.js';

type ToolCommandOptions = {
  json?: boolean;
  printSchema?: boolean;
  inputData?: unknown;
};

type ToolHandler = {
  schema: ZodTypeAny;
  fn: (args: any, context: ToolContext) => Promise<ToolResult<unknown>>;
};

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  'get-plan': {
    schema: getPlanParameters,
    fn: getPlanTool,
  },
  'create-plan': {
    schema: createPlanParameters,
    fn: createPlanTool,
  },
  'update-plan-tasks': {
    schema: generateTasksParameters,
    fn: updatePlanTasksTool,
  },
  'update-plan-details': {
    schema: updatePlanDetailsParameters,
    fn: updatePlanDetailsTool,
  },
  'manage-plan-task': {
    schema: managePlanTaskParameters,
    fn: managePlanTaskTool,
  },
  'list-ready-plans': {
    schema: listReadyPlansParameters,
    fn: listReadyPlansTool,
  },
};

async function readJsonFromStdin(): Promise<unknown> {
  if (process.stdin.isTTY) {
    throw new Error('This command requires JSON input on stdin.');
  }

  const input = await Bun.stdin.text();
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('No JSON input received on stdin.');
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON input: ${message}`);
  }
}

function formatOutput(result: ToolResult<unknown>, options: ToolCommandOptions): string {
  if (options.json) {
    const payload: Record<string, unknown> = {
      success: true,
      result: result.data ?? result.text,
    };

    if (result.message) {
      payload.message = result.message;
    }

    return JSON.stringify(payload, null, 2);
  }

  return result.text;
}

function formatError(error: unknown, options: ToolCommandOptions): string {
  const message = error instanceof Error ? error.message : String(error);

  if (options.json) {
    const isValidationError = error instanceof ZodError || (error as Error)?.name === 'ZodError';
    return JSON.stringify(
      {
        success: false,
        error: message,
        code: isValidationError ? 'VALIDATION_ERROR' : 'ERROR',
      },
      null,
      2
    );
  }

  return `Error: ${message}`;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

export async function handleToolCommand(
  toolName: string,
  options: ToolCommandOptions,
  command: any
): Promise<void> {
  try {
    const handler = TOOL_HANDLERS[toolName];
    if (!handler) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    if (options.printSchema) {
      const jsonSchema = z.toJSONSchema(handler.schema, {
        target: 'draft-7',
        io: 'input',
      });
      writeStdout(ensureTrailingNewline(JSON.stringify(jsonSchema, null, 2)));
      return;
    }

    const globalOpts = command.parent?.parent?.opts?.() ?? {};
    const config = await loadEffectiveConfig(globalOpts.config);
    const pathContext = await resolvePlanPathContext(config);

    const context: ToolContext = {
      config,
      configPath: globalOpts.config,
      gitRoot: pathContext.gitRoot,
    };

    // Use inputData if provided, otherwise read from stdin
    const rawInput = options.inputData ?? (await readJsonFromStdin());
    const parsedArgs = handler.schema.parse(rawInput);
    const result = await handler.fn(parsedArgs, context);

    writeStdout(ensureTrailingNewline(formatOutput(result, options)));
  } catch (error) {
    writeStderr(ensureTrailingNewline(formatError(error, options)));
    process.exit(1);
  }
}
