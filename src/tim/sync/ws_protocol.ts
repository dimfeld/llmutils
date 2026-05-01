import * as z from 'zod/v4';
import { CanonicalSnapshotSchema } from './queue.js';
import { SyncOperationBatchEnvelopeSchema, SyncOperationEnvelopeSchema } from './types.js';

const SyncSequenceIdSchema = z.number().int().nonnegative();

export const SyncHelloFrameSchema = z.object({
  type: z.literal('hello'),
  nodeId: z.string().min(1),
  token: z.string().min(1),
  lastKnownSequenceId: SyncSequenceIdSchema.optional(),
});

export const SyncHelloAckFrameSchema = z.object({
  type: z.literal('hello_ack'),
  mainNodeId: z.string().min(1),
  currentSequenceId: SyncSequenceIdSchema,
});

export const SyncOpBatchFrameSchema = z.object({
  type: z.literal('op_batch'),
  operations: z.array(SyncOperationEnvelopeSchema),
});

export const SyncBatchFrameSchema = z.object({
  type: z.literal('batch'),
  batch: SyncOperationBatchEnvelopeSchema,
});

export const SyncOperationResultSchema = z.object({
  operationId: z.string().min(1),
  status: z.enum(['applied', 'conflict', 'rejected', 'deferred', 'failed_retryable']),
  sequenceIds: z.array(SyncSequenceIdSchema).optional(),
  invalidations: z.array(z.string().min(1)).optional(),
  conflictId: z.string().optional(),
  error: z.string().optional(),
});

export const SyncOpResultFrameSchema = z.object({
  type: z.literal('op_result'),
  results: z.array(SyncOperationResultSchema),
});

export const SyncBatchResultFrameSchema = z.object({
  type: z.literal('batch_result'),
  batchId: z.string().min(1),
  status: z.enum(['applied', 'rejected', 'deferred', 'conflict']),
  results: z.array(SyncOperationResultSchema),
  sequenceIds: z.array(SyncSequenceIdSchema).optional(),
  invalidations: z.array(z.string().min(1)).optional(),
  error: z.string().optional(),
});

export const SyncInvalidateFrameSchema = z.object({
  type: z.literal('invalidate'),
  sequenceId: SyncSequenceIdSchema,
  entityKeys: z.array(z.string().min(1)),
});

export const SyncCatchUpRequestFrameSchema = z.object({
  type: z.literal('catch_up_request'),
  sinceSequenceId: SyncSequenceIdSchema,
});

export const SyncCatchUpInvalidationSchema = z.object({
  sequenceId: SyncSequenceIdSchema,
  entityKeys: z.array(z.string().min(1)),
});

export const SyncCatchUpResponseFrameSchema = z.object({
  type: z.literal('catch_up_response'),
  invalidations: z.array(SyncCatchUpInvalidationSchema),
  currentSequenceId: SyncSequenceIdSchema,
});

export const SyncSnapshotRequestFrameSchema = z.object({
  type: z.literal('snapshot_request'),
  requestId: z.string().min(1),
  entityKeys: z.array(z.string().min(1)),
});

export const SyncSnapshotResponseFrameSchema = z.object({
  type: z.literal('snapshot_response'),
  requestId: z.string().min(1),
  snapshots: z.array(CanonicalSnapshotSchema),
});

export const SyncPingFrameSchema = z.object({ type: z.literal('ping') });
export const SyncPongFrameSchema = z.object({ type: z.literal('pong') });

export const SyncErrorFrameSchema = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string().min(1),
});

export const SyncClientFrameSchema = z.discriminatedUnion('type', [
  SyncHelloFrameSchema,
  SyncBatchFrameSchema,
  SyncOpBatchFrameSchema,
  SyncCatchUpRequestFrameSchema,
  SyncSnapshotRequestFrameSchema,
  SyncPingFrameSchema,
  SyncPongFrameSchema,
]);

export const SyncServerFrameSchema = z.discriminatedUnion('type', [
  SyncHelloAckFrameSchema,
  SyncBatchResultFrameSchema,
  SyncOpResultFrameSchema,
  SyncInvalidateFrameSchema,
  SyncCatchUpResponseFrameSchema,
  SyncSnapshotResponseFrameSchema,
  SyncPingFrameSchema,
  SyncPongFrameSchema,
  SyncErrorFrameSchema,
]);

export const SyncFrameSchema = z.discriminatedUnion('type', [
  SyncHelloFrameSchema,
  SyncHelloAckFrameSchema,
  SyncBatchFrameSchema,
  SyncBatchResultFrameSchema,
  SyncOpBatchFrameSchema,
  SyncOpResultFrameSchema,
  SyncInvalidateFrameSchema,
  SyncCatchUpRequestFrameSchema,
  SyncCatchUpResponseFrameSchema,
  SyncSnapshotRequestFrameSchema,
  SyncSnapshotResponseFrameSchema,
  SyncPingFrameSchema,
  SyncPongFrameSchema,
  SyncErrorFrameSchema,
]);

export type SyncHelloFrame = z.infer<typeof SyncHelloFrameSchema>;
export type SyncHelloAckFrame = z.infer<typeof SyncHelloAckFrameSchema>;
export type SyncOpBatchFrame = z.infer<typeof SyncOpBatchFrameSchema>;
export type SyncBatchFrame = z.infer<typeof SyncBatchFrameSchema>;
export type SyncOperationResult = z.infer<typeof SyncOperationResultSchema>;
export type SyncOpResultFrame = z.infer<typeof SyncOpResultFrameSchema>;
export type SyncBatchResultFrame = z.infer<typeof SyncBatchResultFrameSchema>;
export type SyncInvalidateFrame = z.infer<typeof SyncInvalidateFrameSchema>;
export type SyncCatchUpRequestFrame = z.infer<typeof SyncCatchUpRequestFrameSchema>;
export type SyncCatchUpInvalidation = z.infer<typeof SyncCatchUpInvalidationSchema>;
export type SyncCatchUpResponseFrame = z.infer<typeof SyncCatchUpResponseFrameSchema>;
export type SyncSnapshotRequestFrame = z.infer<typeof SyncSnapshotRequestFrameSchema>;
export type SyncSnapshotResponseFrame = z.infer<typeof SyncSnapshotResponseFrameSchema>;
export type SyncErrorFrame = z.infer<typeof SyncErrorFrameSchema>;
export type SyncClientFrame = z.infer<typeof SyncClientFrameSchema>;
export type SyncServerFrame = z.infer<typeof SyncServerFrameSchema>;
export type SyncFrame = z.infer<typeof SyncFrameSchema>;

export function parseClientFrame(raw: string): SyncClientFrame {
  return SyncClientFrameSchema.parse(JSON.parse(raw));
}
