import type { TimConfig } from '../../tim/configSchema.js';

export function getWebhookSideEffectCutoff(
  config: Pick<TimConfig, 'githubWebhooks'>
): string | null {
  return config.githubWebhooks?.ignoreSideEffectsBefore ?? null;
}

export function isWebhookSideEffectAllowed(
  config: Pick<TimConfig, 'githubWebhooks'>,
  eventAt: string | null | undefined
): boolean {
  const cutoff = getWebhookSideEffectCutoff(config);
  if (!cutoff || !eventAt) {
    return true;
  }

  const cutoffMs = Date.parse(cutoff);
  const eventMs = Date.parse(eventAt);
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(eventMs)) {
    return true;
  }

  return eventMs >= cutoffMs;
}
