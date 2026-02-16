import { describe, test, expect, afterEach, beforeEach, beforeAll, afterAll, mock } from 'bun:test';
import * as net from 'net';
import * as path from 'path';
import { ModuleMocker } from '../../../testing.js';

const selectResponses: Array<string | Error> = [];
const checkboxResponses: Array<string[] | Error> = [];
const inputResponses: Array<string | Error> = [];
const prefixPromptResponses: Array<{ exact: boolean; command: string } | Error> = [];

const mockPromptSelect = mock(async () => {
  const next = selectResponses.shift();
  if (next instanceof Error) {
    throw next;
  }
  if (typeof next !== 'string') {
    throw new Error('No queued select response');
  }
  return next;
});

const mockPromptCheckbox = mock(async () => {
  const next = checkboxResponses.shift();
  if (next instanceof Error) {
    throw next;
  }
  if (!Array.isArray(next)) {
    throw new Error('No queued checkbox response');
  }
  return next;
});

const mockPromptInput = mock(async () => {
  const next = inputResponses.shift();
  if (next instanceof Error) {
    throw next;
  }
  if (typeof next !== 'string') {
    throw new Error('No queued input response');
  }
  return next;
});

const mockPromptPrefixSelect = mock(async () => {
  const next = prefixPromptResponses.shift();
  if (next instanceof Error) {
    throw next;
  }
  if (!next) {
    throw new Error('No queued prefix prompt response');
  }
  return next;
});

const moduleMocker = new ModuleMocker(import.meta);
let setupPermissionsMcp: typeof import('./permissions_mcp_setup.js').setupPermissionsMcp;

beforeAll(async () => {
  await moduleMocker.mock('../../../common/input.js', () => ({
    promptSelect: mockPromptSelect,
    promptCheckbox: mockPromptCheckbox,
    promptInput: mockPromptInput,
    promptPrefixSelect: mockPromptPrefixSelect,
    isPromptTimeoutError: (err: unknown) =>
      err instanceof Error &&
      (err.name === 'AbortPromptError' || err.message.startsWith('Prompt request timed out')),
  }));

  ({ setupPermissionsMcp } = await import('./permissions_mcp_setup.js'));
});

afterAll(() => {
  moduleMocker.clear();
});

describe('permissions socket server line buffering', () => {
  let cleanups: (() => Promise<void>)[] = [];

  beforeEach(() => {
    selectResponses.length = 0;
    checkboxResponses.length = 0;
    inputResponses.length = 0;
    prefixPromptResponses.length = 0;
    mockPromptPrefixSelect.mockClear();
    mockPromptSelect.mockClear();
  });

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

describe('permissions socket server AskUserQuestion handling', () => {
  let cleanups: (() => Promise<void>)[] = [];

  beforeEach(() => {
    selectResponses.length = 0;
    checkboxResponses.length = 0;
    inputResponses.length = 0;
    prefixPromptResponses.length = 0;
    mockPromptPrefixSelect.mockClear();
    mockPromptSelect.mockClear();
  });

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
    cleanups = [];
  });

  function sendAndReceive(socketPath: string, request: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        client.write(JSON.stringify(request) + '\n');
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

  test('handles single-select questions and returns updatedInput payload', async () => {
    selectResponses.push('Summary');

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);

    const questions = [
      {
        question: 'How should I format the output?',
        header: 'Format',
        options: [
          { label: 'Summary', description: 'Brief overview' },
          { label: 'Detailed', description: 'Full explanation' },
        ],
        multiSelect: false,
      },
    ];

    const response = await sendAndReceive(path.join(result.tempDir, 'permissions.sock'), {
      type: 'permission_request',
      requestId: 'ask-1',
      tool_name: 'AskUserQuestion',
      input: { questions },
    });

    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'ask-1',
      approved: true,
      updatedInput: {
        questions,
        answers: {
          'How should I format the output?': 'Summary',
        },
      },
    });

    expect(mockPromptSelect.mock.calls[0]?.[0]?.choices).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: '__free_text__' })])
    );
  });

  test('handles multi-select questions and joins selected labels', async () => {
    checkboxResponses.push(['Introduction', 'Conclusion']);

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);

    const questions = [
      {
        question: 'Which sections should be included?',
        header: 'Sections',
        options: [
          { label: 'Introduction', description: 'Add intro' },
          { label: 'Body', description: 'Add details' },
          { label: 'Conclusion', description: 'Add wrap-up' },
        ],
        multiSelect: true,
      },
    ];

    const response = await sendAndReceive(path.join(result.tempDir, 'permissions.sock'), {
      type: 'permission_request',
      requestId: 'ask-2',
      tool_name: 'AskUserQuestion',
      input: { questions },
    });

    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'ask-2',
      approved: true,
      updatedInput: {
        questions,
        answers: {
          'Which sections should be included?': 'Introduction, Conclusion',
        },
      },
    });

    expect(mockPromptCheckbox.mock.calls[0]?.[0]?.choices).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: '__free_text__' })])
    );
  });

  test('handles free-text single-select answers', async () => {
    selectResponses.push('__free_text__');
    inputResponses.push('custom answer');

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);

    const response = await sendAndReceive(path.join(result.tempDir, 'permissions.sock'), {
      type: 'permission_request',
      requestId: 'ask-3',
      tool_name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'What else should I include?',
            header: 'Extras',
            options: [
              { label: 'None', description: 'No additions' },
              { label: 'Appendix', description: 'Add appendix' },
            ],
            multiSelect: false,
          },
        ],
      },
    });

    expect(response.updatedInput.answers).toEqual({
      'What else should I include?': 'custom answer',
    });
  });

  test('handles free-text multi-select answers', async () => {
    checkboxResponses.push(['Option1', '__free_text__']);
    inputResponses.push('also this');

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);

    const response = await sendAndReceive(path.join(result.tempDir, 'permissions.sock'), {
      type: 'permission_request',
      requestId: 'ask-4',
      tool_name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Pick all relevant items',
            header: 'Items',
            options: [
              { label: 'Option1', description: 'First option' },
              { label: 'Option2', description: 'Second option' },
            ],
            multiSelect: true,
          },
        ],
      },
    });

    expect(response.updatedInput.answers).toEqual({
      'Pick all relevant items': 'Option1, also this',
    });
  });

  test('handles multiple questions sequentially', async () => {
    selectResponses.push('Detailed');
    checkboxResponses.push(['Introduction', 'Conclusion']);

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);

    const questions = [
      {
        question: 'How should I format the output?',
        header: 'Format',
        options: [
          { label: 'Summary', description: 'Brief' },
          { label: 'Detailed', description: 'Long form' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which sections should be included?',
        header: 'Sections',
        options: [
          { label: 'Introduction', description: 'Intro' },
          { label: 'Body', description: 'Main body' },
          { label: 'Conclusion', description: 'Close' },
        ],
        multiSelect: true,
      },
    ];

    const response = await sendAndReceive(path.join(result.tempDir, 'permissions.sock'), {
      type: 'permission_request',
      requestId: 'ask-5',
      tool_name: 'AskUserQuestion',
      input: { questions },
    });

    expect(response.updatedInput).toEqual({
      questions,
      answers: {
        'How should I format the output?': 'Detailed',
        'Which sections should be included?': 'Introduction, Conclusion',
      },
    });
  });

  test('denies AskUserQuestion when prompt times out', async () => {
    const timeoutError = new Error('The prompt timed out');
    timeoutError.name = 'AbortPromptError';
    selectResponses.push(timeoutError);

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);

    const response = await sendAndReceive(path.join(result.tempDir, 'permissions.sock'), {
      type: 'permission_request',
      requestId: 'ask-6',
      tool_name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'How should I format the output?',
            header: 'Format',
            options: [
              { label: 'Summary', description: 'Brief' },
              { label: 'Detailed', description: 'Long form' },
            ],
            multiSelect: false,
          },
        ],
      },
    });

    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'ask-6',
      approved: false,
    });
  });

  test('denies AskUserQuestion when questions array is empty', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);

    const response = await sendAndReceive(path.join(result.tempDir, 'permissions.sock'), {
      type: 'permission_request',
      requestId: 'ask-7',
      tool_name: 'AskUserQuestion',
      input: {
        questions: [],
      },
    });

    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'ask-7',
      approved: false,
    });
  });
});

describe('permissions socket server allowlist persistence behavior', () => {
  let cleanups: (() => Promise<void>)[] = [];

  beforeEach(() => {
    selectResponses.length = 0;
    checkboxResponses.length = 0;
    inputResponses.length = 0;
    prefixPromptResponses.length = 0;
    mockPromptPrefixSelect.mockClear();
    mockPromptSelect.mockClear();
  });

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
    cleanups = [];
  });

  function sendAndReceive(socketPath: string, request: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        client.write(JSON.stringify(request) + '\n');
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

  test('always allow persists non-Bash tool and auto-approves subsequent request', async () => {
    selectResponses.push('always_allow');

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);
    const socketPath = path.join(result.tempDir, 'permissions.sock');

    const firstResponse = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'persist-1',
      tool_name: 'Read',
      input: {},
    });
    expect(firstResponse).toEqual({
      type: 'permission_response',
      requestId: 'persist-1',
      approved: true,
    });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);

    const secondResponse = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'persist-2',
      tool_name: 'Read',
      input: {},
    });
    expect(secondResponse).toEqual({
      type: 'permission_response',
      requestId: 'persist-2',
      approved: true,
    });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
  });

  test('always allow for Bash uses prefixPrompt and persists selected prefix', async () => {
    selectResponses.push('always_allow');
    prefixPromptResponses.push({ exact: false, command: 'git status' });

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);
    const socketPath = path.join(result.tempDir, 'permissions.sock');

    const firstResponse = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'bash-persist-1',
      tool_name: 'Bash',
      input: { command: 'git status --short' },
    });
    expect(firstResponse).toEqual({
      type: 'permission_response',
      requestId: 'bash-persist-1',
      approved: true,
    });
    expect(mockPromptPrefixSelect).toHaveBeenCalledTimes(1);

    const secondResponse = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'bash-persist-2',
      tool_name: 'Bash',
      input: { command: 'git status --porcelain' },
    });
    expect(secondResponse).toEqual({
      type: 'permission_response',
      requestId: 'bash-persist-2',
      approved: true,
    });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
  });

  test('session allow for Bash uses prefixPrompt without persistence', async () => {
    selectResponses.push('session_allow');
    prefixPromptResponses.push({ exact: false, command: 'jj status' });

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);
    const socketPath = path.join(result.tempDir, 'permissions.sock');

    const firstResponse = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'bash-session-1',
      tool_name: 'Bash',
      input: { command: 'jj status -v' },
    });
    expect(firstResponse).toEqual({
      type: 'permission_response',
      requestId: 'bash-session-1',
      approved: true,
    });
    expect(mockPromptPrefixSelect).toHaveBeenCalledTimes(1);

    const secondResponse = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'bash-session-2',
      tool_name: 'Bash',
      input: { command: 'jj status --summary' },
    });
    expect(secondResponse).toEqual({
      type: 'permission_response',
      requestId: 'bash-session-2',
      approved: true,
    });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
  });
});
