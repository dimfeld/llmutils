const APP_SERVER_DISABLED_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);

/**
 * Codex app-server mode is enabled by default and only disabled by explicit false-like values.
 */
export function isCodexAppServerEnabled(
  envValue: string | undefined = process.env.CODEX_USE_APP_SERVER
): boolean {
  if (envValue == null) {
    return true;
  }

  return !APP_SERVER_DISABLED_VALUES.has(envValue.trim().toLowerCase());
}
