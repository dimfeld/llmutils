import { describe, test, expect, afterEach } from 'bun:test';
import * as net from 'net';
import * as path from 'path';
import { setupPermissionsMcp } from './permissions_mcp_setup.js';

describe('permissions socket server line buffering', () => {
  let cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
    cleanups = [];
  });

  function sendAndReceive(
    socketPath: string,
    writes: string[]
  ): Promise<{ type: string; requestId: string; approved: boolean }> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        // Send each write chunk separately
        for (const chunk of writes) {
          client.write(chunk);
        }
      });

      let buffer = '';
      client.on('data', (data) => {
        buffer += data.toString();
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx !== -1) {
          const msg = buffer.slice(0, newlineIdx);
          client.end();
          resolve(JSON.parse(msg));
        }
      });

      client.on('error', reject);
      setTimeout(() => {
        client.end();
        reject(new Error('Timed out waiting for response'));
      }, 5000);
    });
  }

  test('handles a complete message in one chunk', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: ['Edit'],
    });
    cleanups.push(result.cleanup);

    const socketPath = path.join(result.tempDir, 'permissions.sock');
    const request = JSON.stringify({
      type: 'permission_request',
      requestId: 'test-1',
      tool_name: 'Edit',
      input: {},
    });

    const response = await sendAndReceive(socketPath, [request + '\n']);
    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'test-1',
      approved: true,
    });
  });

  test('handles a message split across two chunks', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: ['Edit'],
    });
    cleanups.push(result.cleanup);

    const socketPath = path.join(result.tempDir, 'permissions.sock');
    const request = JSON.stringify({
      type: 'permission_request',
      requestId: 'test-2',
      tool_name: 'Edit',
      input: {},
    });

    // Split the message in the middle
    const midpoint = Math.floor(request.length / 2);
    const chunk1 = request.slice(0, midpoint);
    const chunk2 = request.slice(midpoint) + '\n';

    const response = await sendAndReceive(socketPath, [chunk1, chunk2]);
    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'test-2',
      approved: true,
    });
  });

  test('handles two messages coalesced into one chunk', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: ['Edit', 'Read'],
    });
    cleanups.push(result.cleanup);

    const request1 = JSON.stringify({
      type: 'permission_request',
      requestId: 'test-3a',
      tool_name: 'Edit',
      input: {},
    });
    const request2 = JSON.stringify({
      type: 'permission_request',
      requestId: 'test-3b',
      tool_name: 'Read',
      input: {},
    });

    // Send both messages in a single write
    const responses = await new Promise<any[]>((resolve, reject) => {
      const client = net.createConnection(path.join(result.tempDir, 'permissions.sock'), () => {
        client.write(request1 + '\n' + request2 + '\n');
      });

      let buffer = '';
      const received: any[] = [];
      client.on('data', (data) => {
        buffer += data.toString();
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const msg = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          if (msg) {
            received.push(JSON.parse(msg));
          }
          if (received.length === 2) {
            client.end();
            resolve(received);
          }
        }
      });

      client.on('error', reject);
      setTimeout(() => {
        client.end();
        reject(new Error('Timed out waiting for responses'));
      }, 5000);
    });

    expect(responses).toHaveLength(2);
    const sorted = responses.sort((a, b) => a.requestId.localeCompare(b.requestId));
    expect(sorted[0]).toEqual({
      type: 'permission_response',
      requestId: 'test-3a',
      approved: true,
    });
    expect(sorted[1]).toEqual({
      type: 'permission_response',
      requestId: 'test-3b',
      approved: true,
    });
  });

  test('ignores malformed JSON lines', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: ['Edit'],
    });
    cleanups.push(result.cleanup);

    const socketPath = path.join(result.tempDir, 'permissions.sock');
    // Send a malformed line followed by a valid one
    const validRequest = JSON.stringify({
      type: 'permission_request',
      requestId: 'test-4',
      tool_name: 'Edit',
      input: {},
    });

    const response = await sendAndReceive(socketPath, ['this is not json\n' + validRequest + '\n']);
    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'test-4',
      approved: true,
    });
  });
});
