/** Codex provider selection passed to child tim processes through their environment. */
export const TIM_CODEX_MODEL_PROVIDER = 'TIM_CODEX_MODEL_PROVIDER';

export function getCodexModelProviderArgs(env: Record<string, string | undefined>): string[] {
  const provider = env[TIM_CODEX_MODEL_PROVIDER]?.trim();
  return provider ? ['-c', `model_provider=${JSON.stringify(provider)}`] : [];
}
