import chalk from 'chalk';
import { isPromptTimeoutError, promptPrefixSelect, promptSelect } from '../../../common/input';
import { debugLog, log } from '../../../logging';
import { addPermissionToFile, parseAllowedToolsList } from '../claude_code/permissions_mcp_setup';
import { AppServerRequestError } from './app_server_connection';

const BASH_TOOL_NAME = 'Bash';
const USER_CHOICE_ALLOW = 'allow';
const USER_CHOICE_ALWAYS_ALLOW = 'always_allow';
const USER_CHOICE_SESSION_ALLOW = 'session_allow';
const USER_CHOICE_DECLINE = 'decline';

type AllowedToolsMap = Map<string, true | string[]>;

export interface AppServerApprovalOptions {
  allowedTools?: string[];
  timeoutMs?: number;
  sandboxAllowsFileWrites?: boolean;
  defaultResponse?: 'yes' | 'no';
}

function extractCommandText(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') {
    return undefined;
  }

  const data = params as Record<string, unknown>;
  const directCommand = data.command;
  if (typeof directCommand === 'string') {
    return directCommand;
  }
  if (Array.isArray(directCommand)) {
    return directCommand.map((part) => String(part)).join(' ');
  }

  const commandExecution = data.commandExecution;
  if (commandExecution && typeof commandExecution === 'object') {
    const nested = (commandExecution as Record<string, unknown>).command;
    if (typeof nested === 'string') {
      return nested;
    }
    if (Array.isArray(nested)) {
      return nested.map((part) => String(part)).join(' ');
    }
  }

  const input = data.input;
  if (input && typeof input === 'object') {
    const nested = (input as Record<string, unknown>).command;
    if (typeof nested === 'string') {
      return nested;
    }
    if (Array.isArray(nested)) {
      return nested.map((part) => String(part)).join(' ');
    }
  }

  return undefined;
}

function isCommandAllowed(allowedToolsMap: AllowedToolsMap, command: string): boolean {
  const allowed = allowedToolsMap.get(BASH_TOOL_NAME);
  if (allowed === true) {
    return true;
  }

  if (!Array.isArray(allowed)) {
    return false;
  }

  return allowed.some((prefix) => command.startsWith(prefix));
}

function addBashPrefixSafely(allowedToolsMap: AllowedToolsMap, prefix: string): void {
  const existing = allowedToolsMap.get(BASH_TOOL_NAME);
  if (existing === true) {
    return;
  }
  if (Array.isArray(existing)) {
    if (!existing.includes(prefix)) {
      existing.push(prefix);
    }
    return;
  }
  allowedToolsMap.set(BASH_TOOL_NAME, [prefix]);
}

async function promptForCommandApproval(
  command: string,
  allowedToolsMap: AllowedToolsMap,
  options: AppServerApprovalOptions
): Promise<{ decision: 'accept' | 'decline'; acceptSettings?: { forSession: boolean } }> {
  process.stdout.write('\x07');
  try {
    const userChoice = await promptSelect({
      message: `Codex wants to run a command:\n\n${chalk.blue(command)}\n\nAllow this command?`,
      choices: [
        { name: 'Allow', value: USER_CHOICE_ALLOW },
        { name: 'Allow for Session', value: USER_CHOICE_SESSION_ALLOW },
        { name: 'Always Allow', value: USER_CHOICE_ALWAYS_ALLOW },
        { name: 'Decline', value: USER_CHOICE_DECLINE },
      ],
      timeoutMs: options.timeoutMs,
    });

    if (userChoice === USER_CHOICE_ALLOW) {
      return { decision: 'accept' };
    }

    if (userChoice === USER_CHOICE_DECLINE) {
      return { decision: 'decline' };
    }

    const selectedPrefix = await promptPrefixSelect({
      message:
        userChoice === USER_CHOICE_ALWAYS_ALLOW
          ? 'Select command prefix to always allow:'
          : 'Select command prefix to allow for this session:',
      command,
      timeoutMs: options.timeoutMs,
    });
    addBashPrefixSafely(allowedToolsMap, selectedPrefix.command);

    if (userChoice === USER_CHOICE_ALWAYS_ALLOW) {
      await addPermissionToFile(BASH_TOOL_NAME, selectedPrefix);
      log(chalk.blue(`Bash prefix "${selectedPrefix.command}" added to always allowed list`));
      return { decision: 'accept' };
    }

    log(chalk.blue(`Bash prefix "${selectedPrefix.command}" added for current session`));
    return { decision: 'accept', acceptSettings: { forSession: true } };
  } catch (err) {
    if (isPromptTimeoutError(err)) {
      const defaultResponse = options.defaultResponse ?? 'no';
      return { decision: defaultResponse === 'yes' ? 'accept' : 'decline' };
    }
    debugLog('Command approval prompt failed:', err);
    return { decision: 'decline' };
  }
}

async function promptForFileChangeApproval(
  params: unknown,
  options: AppServerApprovalOptions
): Promise<{ decision: 'accept' | 'decline' }> {
  process.stdout.write('\x07');
  const detail = params ? JSON.stringify(params, null, 2) : '';

  try {
    const decision = await promptSelect({
      message: `Codex wants to apply file changes.\n\n${detail}\n\nAllow these file changes?`,
      choices: [
        { name: 'Allow', value: 'allow' },
        { name: 'Decline', value: 'decline' },
      ],
      timeoutMs: options.timeoutMs,
    });
    return { decision: decision === 'allow' ? 'accept' : 'decline' };
  } catch (err) {
    if (isPromptTimeoutError(err)) {
      const defaultResponse = options.defaultResponse ?? 'no';
      return { decision: defaultResponse === 'yes' ? 'accept' : 'decline' };
    }
    debugLog('File change approval prompt failed:', err);
    return { decision: 'decline' };
  }
}

export function createApprovalHandler(options: AppServerApprovalOptions = {}) {
  const allowAllTools = ['true', '1'].includes(process.env.ALLOW_ALL_TOOLS || '');
  const allowedToolsMap = parseAllowedToolsList(options.allowedTools ?? []);

  return async (method: string, _id: number, params: unknown): Promise<unknown> => {
    if (allowAllTools) {
      return { decision: 'accept' };
    }

    if (method === 'item/commandExecution/requestApproval') {
      const command = extractCommandText(params);
      if (!command) {
        return { decision: 'decline' };
      }

      if (isCommandAllowed(allowedToolsMap, command)) {
        return { decision: 'accept' };
      }

      return await promptForCommandApproval(command, allowedToolsMap, options);
    }

    if (method === 'item/fileChange/requestApproval') {
      if (options.sandboxAllowsFileWrites) {
        return { decision: 'accept' };
      }
      return await promptForFileChangeApproval(params, options);
    }

    throw new AppServerRequestError(`Unsupported method: ${method}`, -32601, { method });
  };
}
