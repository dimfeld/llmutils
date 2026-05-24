import type { TimConfig } from '../../tim/configSchema.js';

const ENV_PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function formatWorkspaceList(workspaces: Record<string, unknown> | undefined): string {
  const workspaceNames = Object.keys(workspaces ?? {}).sort();
  return workspaceNames.length > 0 ? workspaceNames.join(', ') : 'none configured';
}

/**
 * Resolve the bot token for a named Slack workspace from the effective config,
 * expanding ${ENV_VAR} references from process.env.
 */
export function resolveSlackWorkspaceToken(config: TimConfig, workspaceName: string): string {
  const workspaces = config.slack?.workspaces;
  const workspace = workspaces?.[workspaceName];

  if (workspace === undefined) {
    throw new Error(
      `Slack workspace "${workspaceName}" is not configured. Defined Slack workspaces: ${formatWorkspaceList(workspaces)}.`
    );
  }

  const token = workspace.token;
  if (token === undefined || token.trim() === '') {
    throw new Error(`Slack workspace "${workspaceName}" has no bot token configured.`);
  }

  const resolvedToken = token.replace(
    ENV_PLACEHOLDER_PATTERN,
    (_match: string, envVarName: string): string => {
      const envValue = process.env[envVarName];
      if (envValue === undefined || envValue === '') {
        throw new Error(
          `Slack workspace "${workspaceName}" references environment variable "${envVarName}", but it is unset or empty.`
        );
      }
      return envValue;
    }
  );

  if (resolvedToken.trim() === '') {
    throw new Error(`Slack workspace "${workspaceName}" resolved to an empty bot token.`);
  }

  return resolvedToken;
}
