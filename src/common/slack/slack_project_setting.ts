export const SLACK_PROJECT_SETTING_KEY = 'slack';

export interface SlackProjectSetting {
  enabled?: boolean;
  workspace?: string;
  channel?: string;
}

export function parseSlackProjectSetting(value: unknown): SlackProjectSetting | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : undefined,
    workspace: typeof record.workspace === 'string' ? record.workspace : undefined,
    channel: typeof record.channel === 'string' ? record.channel : undefined,
  };
}
