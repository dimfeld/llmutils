import { codexReasoningLevelSchema, type CodexReasoningLevel } from '../schemas.js';

/**
 * Separates an optional `:reasoning-effort` suffix from a Codex model name.
 * For example, `gpt-5.6-sol:high` runs `gpt-5.6-sol` with high reasoning.
 */
export function parseCodexModel(model: string | undefined): {
  model: string | undefined;
  reasoningLevel: CodexReasoningLevel | undefined;
} {
  if (!model) {
    return { model: undefined, reasoningLevel: undefined };
  }

  const separatorIndex = model.lastIndexOf(':');
  if (separatorIndex === -1) {
    return { model, reasoningLevel: undefined };
  }

  const modelName = model.slice(0, separatorIndex);
  const effort = model.slice(separatorIndex + 1);
  const parsedEffort = codexReasoningLevelSchema.safeParse(effort);
  if (!modelName || !parsedEffort.success) {
    throw new Error(
      `Invalid Codex model reasoning effort in "${model}". Use one of: low, medium, high, xhigh.`
    );
  }

  return { model: modelName, reasoningLevel: parsedEffort.data };
}
