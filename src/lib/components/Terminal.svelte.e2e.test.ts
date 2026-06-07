import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

// Must be hoisted before any import that uses @wterm/dom so the mock factory
// can populate the shared store before the component imports the real class.
const instanceStore = vi.hoisted(() => ({ instances: [] as FakeWTerm[] }));

vi.mock('@wterm/dom', () => {
  class FakeWTerm {
    element: HTMLElement;
    onData: ((d: string) => void) | null = null;
    onResize: ((c: number, r: number) => void) | null = null;
    initCalled = false;
    write = vi.fn();
    focus = vi.fn();
    destroy = vi.fn();

    constructor(el: HTMLElement, opts: Record<string, unknown> = {}) {
      this.element = el;
      this.element.classList.add('wterm');
      this.onData = (opts.onData as (d: string) => void) ?? null;
      this.onResize = (opts.onResize as (c: number, r: number) => void) ?? null;
      instanceStore.instances.push(this);
    }

    async init(): Promise<this> {
      this.initCalled = true;
      return this;
    }
  }

  return { WTerm: FakeWTerm };
});

// Declare the fake type alongside the import so TypeScript is happy.
interface FakeWTerm {
  element: HTMLElement;
  onData: ((d: string) => void) | null;
  onResize: ((c: number, r: number) => void) | null;
  initCalled: boolean;
  write: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  init(): Promise<FakeWTerm>;
}

// Fake WebSocket that lets tests drive incoming frames and capture outgoing sends.
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  binaryType = 'arraybuffer';
  url: string;

  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  send = vi.fn();
  close = vi.fn();

  static _instances: FakeWebSocket[] = [];
  static get latest(): FakeWebSocket | undefined {
    return FakeWebSocket._instances.at(-1);
  }
  static reset(): void {
    FakeWebSocket._instances = [];
  }

  constructor(url: string) {
    this.url = url;
    FakeWebSocket._instances.push(this);
  }

  /** Helper for tests — push a text frame into the component's onmessage handler. */
  dispatchMessage(data: string | ArrayBuffer): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

// Import the real component (after mocks are set up).
import Terminal from './Terminal.svelte';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the single WTerm instance once it has been initialized. */
async function waitForTerminal(): Promise<FakeWTerm> {
  return vi.waitFor(
    () => {
      const inst = instanceStore.instances[0];
      if (!inst?.initCalled) throw new Error('WTerm not yet initialized');
      return inst;
    },
    { timeout: 3000 }
  );
}

/** Return the WebSocket once it has been created. */
async function waitForWebSocket(): Promise<FakeWebSocket> {
  return vi.waitFor(
    () => {
      const ws = FakeWebSocket.latest;
      if (!ws) throw new Error('WebSocket not yet created');
      return ws;
    },
    { timeout: 3000 }
  );
}

/** Encode a string as base64 the same way the server does (UTF-8 bytes → btoa). */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Decode a base64 string back to text (the same path as the component's base64ToBytes + decode). */
function decodeBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Terminal.svelte', () => {
  beforeEach(() => {
    instanceStore.instances = [];
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('mounts and initializes a WTerm instance in its container div', async () => {
    render(Terminal, { props: { connectionId: 'conn-mount', wsPort: 8123 } });

    const term = await waitForTerminal();
    expect(term.initCalled).toBe(true);
    expect(term.element).toBeInstanceOf(HTMLElement);
    expect(term.focus).toHaveBeenCalled();
  });

  test('uses the WTerm host as a fixed-height scrollback viewport', async () => {
    render(Terminal, { props: { connectionId: 'conn-viewport', wsPort: 8123 } });

    const term = await waitForTerminal();
    const viewport = document.querySelector('[data-testid="pty-terminal-viewport"]');

    expect(viewport).toBe(term.element);
    expect(term.element.classList.contains('wterm')).toBe(true);
    expect(getComputedStyle(term.element).maxHeight).toBe('100%');
    expect(getComputedStyle(term.element).boxSizing).toBe('border-box');
  });

  test('connects to the PTY websocket with the correct URL', async () => {
    render(Terminal, { props: { connectionId: 'my-session', wsPort: 8123 } });

    const ws = await waitForWebSocket();
    expect(ws.url).toContain('/pty?connectionId=my-session');
    expect(ws.url).toContain(':8123');
  });

  test('decodes incoming base64 pty_output text frames and writes the bytes to the terminal', async () => {
    render(Terminal, { props: { connectionId: 'conn-incoming', wsPort: 8123 } });

    const term = await waitForTerminal();
    const ws = await waitForWebSocket();

    // Simulate a pty_output frame: base64 of "hello\r\n"
    const b64 = encodeBase64('hello\r\n');
    ws.dispatchMessage(b64);

    expect(term.write).toHaveBeenCalledOnce();
    const written = term.write.mock.calls[0][0] as Uint8Array;
    expect(written).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(written)).toBe('hello\r\n');
  });

  test('encodes typed keystrokes as base64 and sends them over the websocket', async () => {
    render(Terminal, { props: { connectionId: 'conn-input', wsPort: 8123 } });

    const term = await waitForTerminal();
    const ws = await waitForWebSocket();

    // Simulate the WTerm onData callback — fires when the user types in the terminal.
    term.onData?.('ls\r');

    expect(ws.send).toHaveBeenCalledOnce();
    const sent = ws.send.mock.calls[0][0] as string;
    expect(typeof sent).toBe('string');
    // The base64 payload must decode back to the original keystroke bytes.
    expect(decodeBase64(sent)).toBe('ls\r');
  });

  test('sends a resize control frame when the terminal fires onResize', async () => {
    render(Terminal, { props: { connectionId: 'conn-resize', wsPort: 8123 } });

    const term = await waitForTerminal();
    const ws = await waitForWebSocket();

    // Simulate the WTerm onResize callback — fires when the container/browser window changes size.
    term.onResize?.(120, 40);

    expect(ws.send).toHaveBeenCalledOnce();
    const sent = ws.send.mock.calls[0][0] as string;
    expect(JSON.parse(sent)).toEqual({ type: 'resize', cols: 120, rows: 40 });
  });

  test('does not send input when the websocket is not yet open', async () => {
    render(Terminal, { props: { connectionId: 'conn-notopen', wsPort: 8123 } });

    const term = await waitForTerminal();
    const ws = await waitForWebSocket();

    // Simulate a not-yet-open socket.
    ws.readyState = FakeWebSocket.CONNECTING;
    term.onData?.('typed');

    expect(ws.send).not.toHaveBeenCalled();
  });

  test('does not send resize when the websocket is not yet open', async () => {
    render(Terminal, { props: { connectionId: 'conn-notopen-resize', wsPort: 8123 } });

    const term = await waitForTerminal();
    const ws = await waitForWebSocket();

    ws.readyState = FakeWebSocket.CONNECTING;
    term.onResize?.(80, 24);

    expect(ws.send).not.toHaveBeenCalled();
  });

  test('flushes the latest terminal size to the PTY once the websocket opens', async () => {
    render(Terminal, { props: { connectionId: 'conn-flush-resize', wsPort: 8123 } });

    const term = await waitForTerminal();
    const ws = await waitForWebSocket();

    // Initial autoResize measurement arrives while the socket is still connecting,
    // so the resize is dropped at send time but the size must be remembered.
    ws.readyState = FakeWebSocket.CONNECTING;
    term.onResize?.(132, 43);
    expect(ws.send).not.toHaveBeenCalled();

    // Socket finishes connecting — the component must flush the remembered size.
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen?.();

    expect(ws.send).toHaveBeenCalledOnce();
    const sent = ws.send.mock.calls[0][0] as string;
    expect(JSON.parse(sent)).toEqual({ type: 'resize', cols: 132, rows: 43 });
  });

  test('closes the websocket and destroys the terminal on component unmount', async () => {
    const { unmount } = render(Terminal, { props: { connectionId: 'conn-destroy', wsPort: 8123 } });

    const term = await waitForTerminal();
    const ws = await waitForWebSocket();

    await unmount();

    expect(ws.close).toHaveBeenCalled();
    expect(term.destroy).toHaveBeenCalled();
  });

  test('handles binary (ArrayBuffer) pty_output frames defensively', async () => {
    render(Terminal, { props: { connectionId: 'conn-binary', wsPort: 8123 } });

    const term = await waitForTerminal();
    const ws = await waitForWebSocket();

    const bytes = new TextEncoder().encode('binary output');
    ws.dispatchMessage(bytes.buffer);

    expect(term.write).toHaveBeenCalledOnce();
    const written = term.write.mock.calls[0][0] as Uint8Array;
    expect(written).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(written)).toBe('binary output');
  });
});
