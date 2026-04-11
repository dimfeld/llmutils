import * as z from 'zod/v4';
import { PostProcessedReviewOutputIssueSchema } from './formatters/review_output_schema';

export const prioritySchema = z.enum(['low', 'medium', 'high', 'urgent', 'maybe']);
export type Priority = z.infer<typeof prioritySchema>;

export const statusSchema = z.enum([
  'pending',
  'in_progress',
  'done',
  'cancelled',
  'deferred',
  'needs_review',
]);

type ObjectFactory = <T extends z.ZodRawShape>(shape: T) => z.ZodObject<T>;

const createLooseObject: ObjectFactory = (shape) => z.object(shape).passthrough();

export const createPlanSchemas = (objectFactory: ObjectFactory = createLooseObject) => {
  const taskSchema = objectFactory({
    title: z.string(),
    done: z.boolean().default(false),
    description: z.string(),
  });

  const phaseSchema = objectFactory({
    title: z.string().optional(),
    goal: z.string().optional(),
    note: z.string().optional(),
    details: z
      .string()
      .optional()
      .describe('Plan details. This can also be in markdown content after the YAML'),
    id: z.number().int().positive(),
    uuid: z.guid().optional(),
    simple: z.boolean().optional(),
    tdd: z.boolean().optional(),
    status: z.preprocess((s) => {
      if (typeof s === 'string') {
        // common synonyms
        if (s === 'complete' || s === 'completed') {
          return 'done';
        }
      }

      return s;
    }, statusSchema.default('pending')),
    priority: prioritySchema.optional(),
    container: z.boolean().optional().describe('Deprecated. Use epic instead.'),
    epic: z
      .boolean()
      .default(false)
      .optional()
      .describe('Mark plan as an epic for organizing children plans'),
    temp: z
      .boolean()
      .default(false)
      .optional()
      .describe('A temporary plan that should be deleted after completion'),
    dependencies: z
      .array(z.number().int().positive())
      .default(() => [])
      .optional(),
    parent: z.number().int().positive().optional(),
    discoveredFrom: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Plan ID that led to discovering this issue during research/implementation'),
    issue: z
      .array(z.url())
      .default(() => [])
      .optional(),
    pullRequest: z
      .array(z.url())
      .default(() => [])
      .optional(),
    docs: z
      .array(z.string())
      .default(() => [])
      .optional(),
    rmfilter: z.array(z.string()).optional(),
    references: z.record(z.string(), z.string()).optional(),
    assignedTo: z.string().optional(),
    planGeneratedAt: z.string().datetime().optional(),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    docsUpdatedAt: z.string().datetime().optional(),
    lessonsAppliedAt: z.string().datetime().optional(),
    materializedAs: z.enum(['primary', 'reference']).optional(),
    tasks: z.array(taskSchema),
    baseBranch: z.string().optional(),
    baseCommit: z.string().optional(),
    baseChangeId: z.string().optional(),
    branch: z.string().optional(),
    changedFiles: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    reviewIssues: z
      .array(
        objectFactory({
          ...PostProcessedReviewOutputIssueSchema.shape,
          category: z.string(),
          file: z.string().optional(),
          line: z.union([z.number(), z.string()]).optional(),
          suggestion: z.string().optional(),
        })
      )
      .optional(),
  }).describe('tim phase file schema');

  const multiPhasePlanSchema = objectFactory({
    title: z.string().optional(),
    goal: z.string(),
    details: z.string().optional(),
    phases: z.array(phaseSchema),
  }).describe('Multi-phase plan structure for split command');

  return {
    phaseSchema,
    taskSchema,
    multiPhasePlanSchema,
  } as const;
};

const defaultSchemas = createPlanSchemas();

export const phaseSchema = defaultSchemas.phaseSchema;
export const multiPhasePlanSchema = defaultSchemas.multiPhasePlanSchema;

export function normalizeContainerToEpic<T extends { container?: boolean; epic?: boolean | null }>(
  plan: T
): Omit<T, 'container'> & { epic?: boolean } {
  if (!plan || typeof plan !== 'object') {
    return plan as Omit<T, 'container'> & { epic?: boolean };
  }

  const { container, epic, ...rest } = plan;
  const normalizedEpic = container === true && epic == null ? true : epic;

  if (normalizedEpic == null) {
    return rest as Omit<T, 'container'> & { epic?: boolean };
  }

  return { ...(rest as Omit<T, 'container'>), epic: normalizedEpic };
}

export const planSchema = phaseSchema;
export type PlanSchema = z.output<typeof phaseSchema>;
export interface LegacyProjectMetadata {
  title: string;
  goal?: string;
  details?: string;
}
export interface LegacyPlanFileMetadata {
  project?: LegacyProjectMetadata;
  not_tim?: boolean;
  generatedBy?: 'agent' | 'oneshot';
  promptsGeneratedAt?: string;
  compactedAt?: string;
  statusDescription?: string;
}
export type PlanWithLegacyMetadata = PlanSchema & LegacyPlanFileMetadata;
export type TaskSchema = z.output<typeof defaultSchemas.taskSchema>;
export type PlanSchemaInput = z.input<typeof phaseSchema>;
export type PlanSchemaInputWithLegacyMetadata = PlanSchemaInput & LegacyPlanFileMetadata;

export type MultiPhasePlanSchema = z.infer<typeof multiPhasePlanSchema>;
