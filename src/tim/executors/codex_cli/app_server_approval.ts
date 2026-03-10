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
  writableRoots?: string[];
  defaultResponse?: 'yes' | 'no';
}

type PermissionLeaf = boolean | string[];
type PermissionProfile = {
  [key: string]: PermissionLeaf | PermissionProfile | undefined;
};

interface PermissionRequestParams {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  reason?: string;
  permissions?: PermissionProfile;
}

interface PermissionApprovalResult {
  permissions: PermissionProfile;
  scope?: 'session';
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clonePermissionProfile(profile: PermissionProfile): PermissionProfile {
  const result: PermissionProfile = {};

  for (const [key, value] of Object.entries(profile)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      result[key] = [...value];
    } else if (isPlainObject(value)) {
      result[key] = clonePermissionProfile(value);
    } else if (typeof value === 'boolean') {
      result[key] = value;
    }
  }

  return result;
}

function hasGrantedPermissions(profile: PermissionProfile | undefined): boolean {
  if (!profile) {
    return false;
  }

  return Object.values(profile).some((value) => {
    if (value === undefined) {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    if (isPlainObject(value)) {
      return hasGrantedPermissions(value);
    }
    return false;
  });
}

function mergePermissionProfiles(
  base: PermissionProfile | undefined,
  addition: PermissionProfile | undefined
): PermissionProfile | undefined {
  if (!base && !addition) {
    return undefined;
  }

  const result = base ? clonePermissionProfile(base) : {};
  if (!addition) {
    return result;
  }

  for (const [key, value] of Object.entries(addition)) {
    if (value === undefined) {
      continue;
    }

    const existing = result[key];
    if (Array.isArray(value)) {
      const merged = Array.isArray(existing) ? [...existing] : [];
      for (const entry of value) {
        if (!merged.includes(entry)) {
          merged.push(entry);
        }
      }
      result[key] = merged;
      continue;
    }

    if (typeof value === 'boolean') {
      if (value) {
        result[key] = true;
      }
      continue;
    }

    if (isPlainObject(value)) {
      const merged = mergePermissionProfiles(isPlainObject(existing) ? existing : undefined, value);
      if (merged && hasGrantedPermissions(merged)) {
        result[key] = merged;
      }
    }
  }

  return hasGrantedPermissions(result) ? result : undefined;
}

function intersectPermissionProfiles(
  requested: PermissionProfile | undefined,
  granted: PermissionProfile | undefined
): PermissionProfile | undefined {
  if (!requested || !granted) {
    return undefined;
  }

  const result: PermissionProfile = {};

  for (const [key, requestedValue] of Object.entries(requested)) {
    if (requestedValue === undefined) {
      continue;
    }

    const grantedValue = granted[key];
    if (grantedValue === undefined) {
      continue;
    }

    if (Array.isArray(requestedValue) && Array.isArray(grantedValue)) {
      const intersection = requestedValue.filter((entry) => grantedValue.includes(entry));
      if (intersection.length > 0) {
        result[key] = intersection;
      }
      continue;
    }

    if (typeof requestedValue === 'boolean' && typeof grantedValue === 'boolean') {
      if (requestedValue && grantedValue) {
        result[key] = true;
      }
      continue;
    }

    if (isPlainObject(requestedValue) && isPlainObject(grantedValue)) {
      const nested = intersectPermissionProfiles(requestedValue, grantedValue);
      if (nested && hasGrantedPermissions(nested)) {
        result[key] = nested;
      }
    }
  }

  return hasGrantedPermissions(result) ? result : undefined;
}

function permissionsEqual(
  a: PermissionProfile | undefined,
  b: PermissionProfile | undefined
): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

function buildSandboxPermissionProfile(
  options: AppServerApprovalOptions
): PermissionProfile | undefined {
  const writableRoots = options.writableRoots?.filter(
    (root) => typeof root === 'string' && root.length > 0
  );
  if (!writableRoots || writableRoots.length === 0) {
    return undefined;
  }

  return {
    fileSystem: {
      write: [...writableRoots],
    },
  };
}

function extractPermissionRequestParams(params: unknown): PermissionRequestParams {
  if (!isPlainObject(params)) {
    return {};
  }

  const permissions = isPlainObject(params.permissions)
    ? (params.permissions as PermissionProfile)
    : undefined;

  return {
    threadId: typeof params.threadId === 'string' ? params.threadId : undefined,
    turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
    itemId: typeof params.itemId === 'string' ? params.itemId : undefined,
    reason: typeof params.reason === 'string' ? params.reason : undefined,
    permissions,
  };
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

async function promptForPermissionsApproval(
  request: PermissionRequestParams,
  options: AppServerApprovalOptions
): Promise<'accept' | 'session' | 'decline'> {
  process.stdout.write('\x07');
  const reason = request.reason ? `${request.reason}\n\n` : '';
  const detail = request.permissions ? JSON.stringify(request.permissions, null, 2) : '{}';

  try {
    const decision = await promptSelect({
      message: `Codex wants additional permissions.\n\n${reason}${detail}\n\nAllow these permissions?`,
      choices: [
        { name: 'Allow', value: USER_CHOICE_ALLOW },
        { name: 'Allow for Session', value: USER_CHOICE_SESSION_ALLOW },
        { name: 'Decline', value: USER_CHOICE_DECLINE },
      ],
      timeoutMs: options.timeoutMs,
    });

    if (decision === USER_CHOICE_ALLOW) {
      return 'accept';
    }
    if (decision === USER_CHOICE_SESSION_ALLOW) {
      return 'session';
    }
    return 'decline';
  } catch (err) {
    if (isPromptTimeoutError(err)) {
      const defaultResponse = options.defaultResponse ?? 'no';
      return defaultResponse === 'yes' ? 'accept' : 'decline';
    }
    debugLog('Permissions approval prompt failed:', err);
    return 'decline';
  }
}

export function createApprovalHandler(options: AppServerApprovalOptions = {}) {
  const allowAllTools = ['true', '1'].includes(process.env.ALLOW_ALL_TOOLS || '');
  const allowedToolsMap = parseAllowedToolsList(options.allowedTools ?? []);
  const sandboxPermissions = buildSandboxPermissionProfile(options);
  const sessionPermissions = new Map<string, PermissionProfile>();
  const turnPermissions = new Map<string, PermissionProfile>();

  return async (method: string, _id: number, params: unknown): Promise<unknown> => {
    if (allowAllTools) {
      if (method === 'item/permissions/requestApproval') {
        const request = extractPermissionRequestParams(params);
        return { permissions: clonePermissionProfile(request.permissions ?? {}) };
      }
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

    if (method === 'item/permissions/requestApproval') {
      const request = extractPermissionRequestParams(params);
      const requestedPermissions = request.permissions ?? {};
      const automaticPermissions = mergePermissionProfiles(
        mergePermissionProfiles(
          sandboxPermissions,
          request.threadId ? sessionPermissions.get(request.threadId) : undefined
        ),
        request.turnId ? turnPermissions.get(request.turnId) : undefined
      );
      const automaticallyGranted = intersectPermissionProfiles(
        requestedPermissions,
        automaticPermissions
      );

      if (permissionsEqual(automaticallyGranted, requestedPermissions)) {
        return {
          permissions: clonePermissionProfile(automaticallyGranted ?? {}),
        } satisfies PermissionApprovalResult;
      }

      const decision = await promptForPermissionsApproval(request, options);
      if (decision === 'decline') {
        return {
          permissions: clonePermissionProfile(automaticallyGranted ?? {}),
        } satisfies PermissionApprovalResult;
      }

      if (request.turnId) {
        turnPermissions.set(
          request.turnId,
          mergePermissionProfiles(turnPermissions.get(request.turnId), requestedPermissions) ?? {}
        );
      }

      if (decision === 'session' && request.threadId) {
        sessionPermissions.set(
          request.threadId,
          mergePermissionProfiles(sessionPermissions.get(request.threadId), requestedPermissions) ??
            {}
        );
      }

      return {
        ...(decision === 'session' ? { scope: 'session' as const } : {}),
        permissions: clonePermissionProfile(requestedPermissions),
      } satisfies PermissionApprovalResult;
    }

    throw new AppServerRequestError(`Unsupported method: ${method}`, -32601, { method });
  };
}
