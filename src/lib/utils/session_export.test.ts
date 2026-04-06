import { describe, it, expect } from 'vitest';
import {
  formatMessageAsMarkdown,
  formatSessionHeader,
  exportSessionAsMarkdown,
  generateExportFilename,
} from './session_export.js';
import type {
  DisplayMessage,
  SessionData,
  HeadlessSessionInfo,
  StructuredMessagePayload,
} from '$lib/types/session.js';

function makeMessage(
  overrides: Partial<DisplayMessage> & Pick<DisplayMessage, 'body'>
): DisplayMessage {
  return {
    id: 'msg-1',
    seq: 1,
    timestamp: '2026-03-15T10:30:45.000Z',
    category: 'log',
    bodyType: overrides.body.type,
    rawType: 'test',
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    connectionId: 'conn-1',
    sessionInfo: {
      command: 'tim agent',
      planId: 42,
      planTitle: 'Add export feature',
      workspacePath: '/home/user/project',
      gitRemote: 'https://github.com/user/repo',
    } satisfies HeadlessSessionInfo,
    status: 'active',
    projectId: 1,
    messages: [],
    activePrompts: [],
    isReplaying: false,
    groupKey: 'test',
    connectedAt: '2026-03-15T10:00:00.000Z',
    disconnectedAt: null,
    ...overrides,
  };
}

describe('formatMessageAsMarkdown', () => {
  it('formats text messages', () => {
    const msg = makeMessage({ body: { type: 'text', text: 'Hello world' } });
    const result = formatMessageAsMarkdown(msg);
    expect(result).toContain('Hello world');
    expect(result).toMatch(/\*\*\[.*UTC\]\*\*/);
  });

  it('formats monospaced messages in code blocks', () => {
    const msg = makeMessage({ body: { type: 'monospaced', text: 'console.log("hi")' } });
    const result = formatMessageAsMarkdown(msg);
    expect(result).toContain('```\nconsole.log("hi")\n```');
  });

  it('uses longer fence when monospaced content contains backticks', () => {
    const msg = makeMessage({
      body: { type: 'monospaced', text: 'some ```code``` here' },
    });
    const result = formatMessageAsMarkdown(msg);
    expect(result).toContain('````\nsome ```code``` here\n````');
  });

  it('formats todoList messages as checkboxes', () => {
    const msg = makeMessage({
      body: {
        type: 'todoList',
        items: [
          { label: 'Done task', status: 'completed' },
          { label: 'Pending task', status: 'pending' },
          { label: 'Active task', status: 'in_progress' },
          { label: 'Blocked task', status: 'blocked' },
          { label: 'Unknown task', status: 'unknown' },
        ],
        explanation: 'Task update',
      },
    });
    const result = formatMessageAsMarkdown(msg);
    expect(result).toContain('- [x] Done task');
    expect(result).toContain('- [ ] Pending task');
    expect(result).toContain('- [>] Active task');
    expect(result).toContain('- [-] Blocked task');
    expect(result).toContain('- [ ] Unknown task');
    expect(result).toContain('Task update');
  });

  it('formats todoList without explanation', () => {
    const msg = makeMessage({
      body: {
        type: 'todoList',
        items: [{ label: 'A task', status: 'pending' }],
      },
    });
    const result = formatMessageAsMarkdown(msg);
    expect(result).toContain('- [ ] A task');
    expect(result).not.toContain('undefined');
  });

  it('formats fileChanges messages', () => {
    const msg = makeMessage({
      body: {
        type: 'fileChanges',
        changes: [
          { path: 'src/new.ts', kind: 'added' },
          { path: 'src/old.ts', kind: 'removed' },
          { path: 'src/mod.ts', kind: 'updated' },
        ],
        status: 'Files changed',
      },
    });
    const result = formatMessageAsMarkdown(msg);
    expect(result).toContain('`+ src/new.ts`');
    expect(result).toContain('`- src/old.ts`');
    expect(result).toContain('`~ src/mod.ts`');
    expect(result).toContain('Files changed');
  });

  it('formats keyValuePairs messages', () => {
    const msg = makeMessage({
      body: {
        type: 'keyValuePairs',
        entries: [
          { key: 'Tool', value: 'grep' },
          { key: 'Summary', value: 'Found 3 matches' },
        ],
      },
    });
    const result = formatMessageAsMarkdown(msg);
    expect(result).toContain('**Tool**: grep');
    expect(result).toContain('**Summary**: Found 3 matches');
  });

  it('formats multiline key-value entries in fenced code blocks', () => {
    const msg = makeMessage({
      body: {
        type: 'keyValuePairs',
        entries: [
          { key: 'Input', value: '{\n  "foo": "bar"\n}' },
          { key: 'Simple', value: 'one-liner' },
        ],
      },
    });
    const result = formatMessageAsMarkdown(msg);
    expect(result).toContain('- **Input**:\n```\n{\n  "foo": "bar"\n}\n```');
    expect(result).toContain('- **Simple**: one-liner');
  });

  it('formats review_result messages with full details', () => {
    const reviewPayload: StructuredMessagePayload = {
      type: 'review_result',
      verdict: 'NEEDS_FIXES',
      fixInstructions: 'Fix the issues below',
      issues: [
        {
          severity: 'critical',
          category: 'bug',
          content: 'Null pointer dereference',
          file: 'src/main.ts',
          line: '42',
          suggestion: 'Add null check',
        },
        {
          severity: 'minor',
          category: 'style',
          content: 'Inconsistent naming',
          file: 'src/utils.ts',
          line: '',
          suggestion: '',
        },
      ],
      recommendations: ['Add more tests', 'Improve error handling'],
      actionItems: ['Fix critical bug', 'Update docs'],
    } as unknown as StructuredMessagePayload;

    const msg = makeMessage({
      body: { type: 'structured', message: reviewPayload },
      rawType: 'review_result',
    });
    const result = formatMessageAsMarkdown(msg);
    expect(result).toContain('**Review: NEEDS FIXES**');
    expect(result).toContain('Fix the issues below');
    expect(result).toContain('Critical');
    expect(result).toContain('[bug] `src/main.ts:42` Null pointer dereference');
    expect(result).toContain('Suggestion: Add null check');
    expect(result).toContain('Minor');
    expect(result).toContain('[style]');
    expect(result).toContain('**Recommendations**');
    expect(result).toContain('- Add more tests');
    expect(result).toContain('**Action Items**');
    expect(result).toContain('- Fix critical bug');
  });

  it('formats ACCEPTABLE review_result', () => {
    const reviewPayload: StructuredMessagePayload = {
      type: 'review_result',
      verdict: 'ACCEPTABLE',
      issues: [],
      recommendations: [],
      actionItems: [],
    } as unknown as StructuredMessagePayload;

    const msg = makeMessage({
      body: { type: 'structured', message: reviewPayload },
      rawType: 'review_result',
    });
    const result = formatMessageAsMarkdown(msg);
    expect(result).toContain('**Review: ACCEPTABLE**');
  });

  it('formats structured messages via formatStructuredMessage', () => {
    const structuredPayload: StructuredMessagePayload = {
      type: 'llm_response',
      text: 'Here is my response',
    } as unknown as StructuredMessagePayload;

    const msg = makeMessage({
      body: { type: 'structured', message: structuredPayload },
      bodyType: 'structured',
      rawType: 'llm_response',
    });
    const result = formatMessageAsMarkdown(msg);
    expect(result).toContain('Here is my response');
  });

  it('formats UNKNOWN review_result and skips empty optional sections', () => {
    const reviewPayload: StructuredMessagePayload = {
      type: 'review_result',
      verdict: 'UNKNOWN',
      issues: [],
      recommendations: [],
      actionItems: [],
    } as unknown as StructuredMessagePayload;

    const msg = makeMessage({
      body: { type: 'structured', message: reviewPayload },
      rawType: 'review_result',
    });
    const result = formatMessageAsMarkdown(msg);
    expect(result).toContain('**Review: UNKNOWN**');
    expect(result).not.toContain('**Recommendations**');
    expect(result).not.toContain('**Action Items**');
  });

  it('formats review_result based on payload type, regardless of rawType', () => {
    const msg = makeMessage({
      body: {
        type: 'structured',
        message: { type: 'review_result', verdict: 'ACCEPTABLE' } as StructuredMessagePayload,
      },
      rawType: 'not-review-result',
    });
    const result = formatMessageAsMarkdown(msg);
    expect(result).toContain('**Review: ACCEPTABLE**');
  });

  it('falls back when a structured message resolves to an unsupported body', () => {
    const msg = makeMessage({
      body: {
        type: 'structured',
        message: { type: 'unknown_message_type' } as StructuredMessagePayload,
      },
      rawType: 'unknown_message_type',
    });
    const result = formatMessageAsMarkdown(msg);
    expect(result).toContain('Unsupported structured message type: unknown_message_type');
  });

  it('formats structured-message render errors as text', () => {
    const throwingPayload = {
      get type() {
        throw new Error('bad payload');
      },
    } as StructuredMessagePayload;

    const msg = makeMessage({
      body: { type: 'structured', message: throwingPayload },
      rawType: 'broken_structured',
    });
    const result = formatMessageAsMarkdown(msg);
    expect(result).toContain('[render error: broken_structured]');
  });
});

describe('formatSessionHeader', () => {
  it('includes all metadata fields', () => {
    const session = makeSession({
      disconnectedAt: '2026-03-15T11:00:00.000Z',
    });
    const header = formatSessionHeader(session);
    expect(header).toContain('# Session: tim agent');
    expect(header).toContain('**Plan**: #42 — Add export feature');
    expect(header).toContain('**Workspace**: /home/user/project');
    expect(header).toContain('**Git Remote**: https://github.com/user/repo');
    expect(header).toContain('**Started**:');
    expect(header).toContain('**Ended**:');
  });

  it('omits missing optional fields', () => {
    const session = makeSession({
      sessionInfo: { command: 'tim generate' },
      disconnectedAt: null,
    });
    const header = formatSessionHeader(session);
    expect(header).toContain('# Session: tim generate');
    expect(header).not.toContain('Plan');
    expect(header).not.toContain('Workspace');
    expect(header).not.toContain('Git Remote');
    expect(header).not.toContain('Ended');
    expect(header).toContain('Started');
  });

  it('handles planId without planTitle', () => {
    const session = makeSession({
      sessionInfo: { command: 'test', planId: 10 },
    });
    const header = formatSessionHeader(session);
    expect(header).toContain('**Plan**: #10');
  });

  it('handles planTitle without planId', () => {
    const session = makeSession({
      sessionInfo: { command: 'test', planTitle: 'My Plan' },
    });
    const header = formatSessionHeader(session);
    expect(header).toContain('**Plan**: My Plan');
  });
});

describe('exportSessionAsMarkdown', () => {
  it('returns header with no-messages note for empty session', () => {
    const session = makeSession();
    const result = exportSessionAsMarkdown(session);
    expect(result).toContain('# Session: tim agent');
    expect(result).toContain('*No messages*');
    expect(result).not.toContain('---');
  });

  it('combines header and messages with separator', () => {
    const session = makeSession({
      messages: [
        makeMessage({ body: { type: 'text', text: 'First message' } }),
        makeMessage({
          id: 'msg-2',
          seq: 2,
          body: { type: 'text', text: 'Second message' },
        }),
      ],
    });
    const result = exportSessionAsMarkdown(session);
    expect(result).toContain('# Session: tim agent');
    expect(result).toContain('---');
    expect(result).toContain('First message');
    expect(result).toContain('Second message');
  });

  it('handles mixed body types', () => {
    const session = makeSession({
      messages: [
        makeMessage({ body: { type: 'text', text: 'Hello' } }),
        makeMessage({
          id: 'msg-2',
          seq: 2,
          body: { type: 'monospaced', text: 'code()' },
        }),
        makeMessage({
          id: 'msg-3',
          seq: 3,
          body: {
            type: 'todoList',
            items: [{ label: 'Task', status: 'completed' }],
          },
        }),
      ],
    });
    const result = exportSessionAsMarkdown(session);
    expect(result).toContain('Hello');
    expect(result).toContain('```\ncode()\n```');
    expect(result).toContain('- [x] Task');
  });

  it('preserves message order and separates entries with blank lines', () => {
    const session = makeSession({
      messages: [
        makeMessage({ body: { type: 'text', text: 'First message' } }),
        makeMessage({
          id: 'msg-2',
          seq: 2,
          body: { type: 'keyValuePairs', entries: [{ key: 'Tool', value: 'rg' }] },
        }),
      ],
    });
    const result = exportSessionAsMarkdown(session);
    expect(result).toMatch(/First message\n\n\*\*\[/);
    expect(result.indexOf('First message')).toBeLessThan(result.indexOf('**Tool**: rg'));
  });
});

describe('generateExportFilename', () => {
  it('produces a valid filename', () => {
    const session = makeSession();
    const filename = generateExportFilename(session);
    expect(filename).toMatch(/^session-tim-agent-42-.*\.md$/);
  });

  it('sanitizes special characters in command', () => {
    const session = makeSession({
      sessionInfo: { command: 'tim agent --flag=value/path' },
    });
    const filename = generateExportFilename(session);
    expect(filename).not.toMatch(/[^a-zA-Z0-9_.\-]/);
  });

  it('omits planId when missing', () => {
    const session = makeSession({
      sessionInfo: { command: 'tim generate' },
    });
    const filename = generateExportFilename(session);
    expect(filename).toMatch(/^session-tim-generate-\d{4}.*\.md$/);
    expect(filename).not.toContain('undefined');
  });

  it('handles empty command without double dash', () => {
    const session = makeSession({
      sessionInfo: { command: '' },
    });
    const filename = generateExportFilename(session);
    expect(filename).toMatch(/^session-\d{4}.*\.md$/);
    expect(filename).not.toContain('session--');
  });

  it('truncates long sanitized commands and removes repeated separators', () => {
    const session = makeSession({
      sessionInfo: {
        command: 'tim////agent with a very very very very very very very long command name!!!',
        planId: 42,
      },
    });
    const filename = generateExportFilename(session);
    expect(filename).toMatch(/^session-[a-zA-Z0-9_-]+-42-\d{4}.*\.md$/);
    expect(filename).not.toContain('--');

    const commandPart = filename.replace(/^session-/, '').replace(/-42-\d{4}.*\.md$/, '');
    expect(commandPart.length).toBeLessThanOrEqual(50);
  });
});
