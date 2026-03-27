import type { PlanSchema } from '../planSchema.js';

export function mergeYamlPassthroughFields(target: PlanSchema, source: PlanSchema): void {
  if (source.rmfilter) {
    target.rmfilter = source.rmfilter;
  }
  if (source.generatedBy) {
    target.generatedBy = source.generatedBy;
  }
  if (source.promptsGeneratedAt) {
    target.promptsGeneratedAt = source.promptsGeneratedAt;
  }
  if (source.compactedAt) {
    target.compactedAt = source.compactedAt;
  }
  if (source.statusDescription !== undefined) {
    target.statusDescription = source.statusDescription;
  }
}
