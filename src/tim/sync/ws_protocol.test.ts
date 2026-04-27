import { describe, expect, test } from 'vitest';
import { SyncFrameSchema } from './ws_protocol.js';

describe('sync WebSocket protocol schemas', () => {
  test('validates discriminated frames', () => {
    expect(
      SyncFrameSchema.parse({
        type: 'hello',
        nodeId: 'node-a',
        token: 'secret',
        lastKnownSequenceId: 0,
      })
    ).toEqual({
      type: 'hello',
      nodeId: 'node-a',
      token: 'secret',
      lastKnownSequenceId: 0,
    });
  });

  test('rejects malformed frames', () => {
    expect(() =>
      SyncFrameSchema.parse({
        type: 'catch_up_request',
        sinceSequenceId: -1,
      })
    ).toThrow();
  });

  test('validates batch frames', () => {
    const frame = SyncFrameSchema.parse({
      type: 'batch',
      batch: {
        batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        originNodeId: 'node-a',
        createdAt: '2026-01-01T00:00:00.000Z',
        operations: [
          {
            operationUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            projectUuid: '11111111-1111-4111-8111-111111111111',
            originNodeId: 'node-a',
            localSequence: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            targetType: 'plan',
            targetKey: 'plan:22222222-2222-4222-8222-222222222222',
            op: {
              type: 'plan.add_tag',
              planUuid: '22222222-2222-4222-8222-222222222222',
              tag: 'sync',
            },
          },
        ],
        reason: 'test',
      },
    });

    expect(frame.type).toBe('batch');
  });
});
