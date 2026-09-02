import { claudeCodeReasoningEffortSchema, type ClaudeCodeReasoningEffort } from '../schemas.js';

/**
 * Separates an optional `:reasoning-effort` suffix from a Claude model name.
 * For example, `claude-opus-4:high` runs `claude-opus-4` with high effort.
 */
export function parseClaudeModel(model: string | undefined): {
  model: string | undefined;
  reasoningEffort: ClaudeCodeReasoningEffort | undefined;
} {
  if (!model) {
    return { model: undefined, reasoningEffort: undefined };
  }

  const separatorIndex = model.lastIndexOf(':');
  if (separatorIndex === -1) {
    return { model, reasoningEffort: undefined };
  }

  const modelName = model.slice(0, separatorIndex);
  const effort = model.slice(separatorIndex + 1);
  const parsedEffort = claudeCodeReasoningEffortSchema.safeParse(effort);
  if (!modelName || !parsedEffort.success) {
    throw new Error(
      `Invalid Claude model reasoning effort in "${model}". Use one of: low, medium, high, xhigh, max.`
    );
  }

  return { model: modelName, reasoningEffort: parsedEffort.data };
}

export function isRecognizedClaudeModel(model: string | undefined): model is string {
  return (
    model !== undefined &&
    (model.includes('haiku') ||
      model.includes('sonnet') ||
      model.includes('opus') ||
      model.includes('fable'))
  );
}
