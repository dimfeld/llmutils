import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { getTimConfigRoot } from '../../common/config_paths.js';
import {
  syncConfigSchema,
  type SyncAllowedNodeConfig,
  type SyncNodeRole,
  type TimConfig,
} from '../configSchema.js';

export interface ResolvedSyncConfig {
  enabled: boolean;
  offline: boolean;
  disabled: boolean;
  role?: SyncNodeRole;
  nodeId?: string;
  mainUrl?: string;
  nodeToken: string | null;
  allowedNodes: SyncAllowedNodeConfig[];
  serverPort?: number;
  serverHost?: string;
  requireSecureTransport?: boolean;
  pollIntervalSeconds?: number;
  sequenceRetentionDays: number;
  validationErrors: string[];
}

function globalConfigPath(): string {
  return path.join(getTimConfigRoot(), 'config.yml');
}

export function resolveNodeToken(sync: TimConfig['sync']): string | null {
  if (!sync) {
    return null;
  }
  if (sync.nodeToken) {
    return sync.nodeToken;
  }
  if (sync.nodeTokenEnv) {
    const value = process.env[sync.nodeTokenEnv];
    return value && value.length > 0 ? value : null;
  }
  return null;
}

export function validateSyncConfig(config: TimConfig): string[] {
  const sync = config.sync;
  if (!sync) {
    return [];
  }

  const errors: string[] = [];
  const schemaResult = syncConfigSchema.safeParse(sync);
  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues) {
      errors.push(`${issue.path.join('.') || 'sync'}: ${issue.message}`);
    }
  }

  // When sync is explicitly disabled, skip role/transport requirement errors.
  // The kill switch should produce a clean disabled state, not a state littered
  // with bogus "required field missing" errors.
  if (sync.disabled) {
    return errors;
  }

  if (!sync.role) {
    errors.push('sync.role is required to enable sync');
  }

  if (sync.role === 'persistent') {
    if (!sync.mainUrl) {
      errors.push('sync.mainUrl is required for persistent sync nodes');
    }
    if (!resolveNodeToken(sync)) {
      errors.push(
        'sync.nodeToken or a set sync.nodeTokenEnv is required for persistent sync nodes'
      );
    }
  }

  if (sync.role === 'main') {
    for (const [index, node] of (sync.allowedNodes ?? []).entries()) {
      const tokenSourceCount = Number(Boolean(node.tokenHash)) + Number(Boolean(node.tokenEnv));
      if (tokenSourceCount !== 1) {
        errors.push(`sync.allowedNodes.${index} must set exactly one of tokenHash or tokenEnv`);
      }
    }
  }

  return errors;
}

export function resolveSyncConfig(config: TimConfig): ResolvedSyncConfig {
  const sync = config.sync;
  const disabled = sync?.disabled ?? false;
  const offline = sync?.offline ?? false;
  const validationErrors = validateSyncConfig(config);
  const nodeToken = resolveNodeToken(sync);
  const role = sync?.role;
  // Ephemeral nodes do not open their own connection to the main node — they
  // sync via the persistent/main process that spawned them. They must therefore
  // never resolve as "enabled" for the purposes of automatic sync startup.
  const hasRoleRequirements =
    role === 'main' || (role === 'persistent' && Boolean(sync?.mainUrl) && Boolean(nodeToken));

  return {
    enabled: Boolean(sync && !disabled && validationErrors.length === 0 && hasRoleRequirements),
    offline,
    disabled,
    role,
    nodeId: sync?.nodeId,
    mainUrl: sync?.mainUrl,
    nodeToken,
    allowedNodes: sync?.allowedNodes ?? [],
    serverPort: sync?.serverPort,
    serverHost: sync?.serverHost,
    requireSecureTransport: sync?.requireSecureTransport,
    pollIntervalSeconds: sync?.pollIntervalSeconds,
    sequenceRetentionDays: sync?.sequenceRetentionDays ?? 30,
    validationErrors,
  };
}

async function readGlobalConfigFile(): Promise<Record<string, unknown>> {
  const configPath = globalConfigPath();
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const parsed = yaml.load(content);
    if (parsed === null || parsed === undefined) {
      return {};
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Global tim config must be a YAML object: ${configPath}`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }
}

async function writeGlobalConfigFile(config: Record<string, unknown>): Promise<void> {
  const configPath = globalConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, yaml.dump(config), 'utf-8');
}

export async function ensureNodeId(config: TimConfig): Promise<string> {
  if (config.sync?.nodeId) {
    return config.sync.nodeId;
  }

  const nodeId = randomUUID();
  const globalConfig = await readGlobalConfigFile();
  const currentSync =
    globalConfig.sync && typeof globalConfig.sync === 'object' && !Array.isArray(globalConfig.sync)
      ? (globalConfig.sync as Record<string, unknown>)
      : {};

  globalConfig.sync = {
    ...currentSync,
    nodeId,
  };

  const validationResult = syncConfigSchema.safeParse(globalConfig.sync);
  if (!validationResult.success) {
    const details = validationResult.error.issues
      .map((issue) => `- sync.${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Cannot persist sync.nodeId because global sync config is invalid:\n${details}`
    );
  }

  await writeGlobalConfigFile(globalConfig);
  config.sync = {
    ...(config.sync ?? {}),
    nodeId,
  };
  return nodeId;
}

export async function getLocalNodeId(config: TimConfig): Promise<string> {
  return ensureNodeId(config);
}
