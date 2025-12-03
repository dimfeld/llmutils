import { z } from 'zod/v4';

export const prioritySchema = z.enum(['low', 'medium', 'high', 'urgent', 'maybe']);
export type Priority = z.infer<typeof prioritySchema>;

export const statusSchema = z.enum(['pending', 'in_progress', 'done', 'cancelled', 'deferred']);

type ObjectFactory = <T extends z.ZodRawShape>(shape: T) => z.ZodObject<T>;

const createLooseObject: ObjectFactory = (shape) => z.object(shape).passthrough();

export const createPlanSchemas = (objectFactory: ObjectFactory = createLooseObject) => {
  const progressNoteSchema = objectFactory({
    timestamp: z.string().datetime(),
    text: z.string(),
    source: z.string().optional(),
  });

  const taskSchema = objectFactory({
    title: z.string(),
    done: z.boolean().default(false),
    description: z.string(),
  });

  const projectSchema = objectFactory({
    title: z.string(),
    goal: z.string().optional(),
    details: z.string().optional(),
  });

  const phaseSchema = objectFactory({
    title: z.string().optional(),
    goal: z.string().optional(),
    details: z
      .string()
      .optional()
      .describe('Plan details. This can also be in markdown content after the YAML'),
    id: z.coerce.number().int().positive().optional(),
    uuid: z.guid().optional(),
    generatedBy: z.enum(['agent', 'oneshot']).optional(),
    simple: z.boolean().optional(),
    status: z.preprocess((s) => {
      if (typeof s === 'string') {
        // common synonyms
        if (s === 'complete' || s === 'completed') {
          return 'done';
        }
      }

      return s;
    }, statusSchema.default('pending')),
    statusDescription: z.string().optional(),
    priority: prioritySchema.optional(),
    container: z.boolean().default(false).optional(),
    temp: z.boolean().default(false).optional(),
    dependencies: z.array(z.coerce.number().int().positive()).default([]).optional(),
    parent: z.coerce.number().int().positive().optional(),
    discoveredFrom: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe('Plan ID that led to discovering this issue during research/implementation'),
    references: z
      .record(z.string(), z.guid())
      .default({})
      .optional()
      .describe(
        'Maps numeric plan IDs to their UUIDs for deterministic tracking across renumbering'
      ),
    issue: z.array(z.url()).default([]).optional(),
    pullRequest: z.array(z.url()).default([]).optional(),
    docs: z.array(z.string()).default([]).optional(),
    assignedTo: z.string().optional(),
    planGeneratedAt: z.string().datetime().optional(),
    promptsGeneratedAt: z.string().datetime().optional(),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    compactedAt: z.string().datetime().optional(),
    progressNotes: z.array(progressNoteSchema).default([]).optional(),
    project: projectSchema.optional(),
    tasks: z.array(taskSchema),
    baseBranch: z.string().optional(),
    changedFiles: z.array(z.string()).optional(),
    rmfilter: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  }).describe('rmplan phase file schema');

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

export type PhaseSchema = z.output<typeof phaseSchema>;

// Backward compatibility - export phaseSchema as planSchema
export const planSchema = phaseSchema;
export type PlanSchema = PhaseSchema;
export type PlanSchemaWithFilename = PlanSchema & {
  filename: string;
};
export type TaskSchema = z.output<typeof defaultSchemas.taskSchema>;
export type PlanSchemaInput = z.input<typeof phaseSchema>;
export type PlanSchemaInputWithFilename = PlanSchemaInput & {
  filename: string;
};

export type MultiPhasePlanSchema = z.infer<typeof multiPhasePlanSchema>;
