<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { WTerm } from '@wterm/dom';
  import '@wterm/dom/css';

  let {
    connectionId,
    wsPort,
    cols = 80,
    rows = 24,
  }: {
    connectionId: string;
    wsPort: number;
    cols?: number;
    rows?: number;
  } = $props();

  let container: HTMLDivElement | undefined = $state();

  // These are plain (non-reactive) locals: they are only touched from lifecycle
  // and websocket callbacks, never read in the template.
  let term: WTerm | null = null;
  let ws: WebSocket | null = null;
  let destroyed = false;
  // Latest known terminal size. The initial autoResize measurement can fire
  // before the websocket finishes connecting, so we remember it and flush it on
  // open — otherwise the PTY would stay at the default size until a manual resize.
  let lastCols = 80;
  let lastRows = 24;

  const CHUNK_SIZE = 0x8000;

  /** Base64-encode raw bytes, chunking to avoid call-stack overflow on large inputs. */
  function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, i + CHUNK_SIZE);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  /** Decode a base64 string into raw bytes. */
  function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /** Tear down the terminal and websocket. Safe to call multiple times. */
  function teardown(): void {
    destroyed = true;
    if (ws) {
      // Detach handlers so a late close/message can't touch a destroyed terminal.
      ws.onmessage = null;
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // Ignore errors closing an already-closing socket.
      }
      ws = null;
    }
    if (term) {
      term.destroy();
      term = null;
    }
  }

  /** Write an incoming PTY frame (base64 text, or binary) into the terminal. */
  function handlePtyFrame(data: string | ArrayBuffer | Uint8Array): void {
    if (!term) return;
    if (typeof data === 'string') {
      // The server sends raw text frames containing base64-encoded PTY bytes.
      term.write(base64ToBytes(data));
      return;
    }
    // Be defensive: handle binary frames (ArrayBuffer) too.
    term.write(new Uint8Array(data));
  }

  /** Send keystroke input to the PTY as a raw base64 text frame. */
  function sendInput(data: string): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const bytes = new TextEncoder().encode(data);
    ws.send(bytesToBase64(bytes));
  }

  /** Send a resize control frame to the PTY (last-resize-wins on the server). */
  function sendResize(nextCols: number, nextRows: number): void {
    // Always remember the latest size so it can be flushed once the socket opens,
    // even if this call happens while the websocket is still connecting.
    lastCols = nextCols;
    lastRows = nextRows;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'resize', cols: nextCols, rows: nextRows }));
  }

  onMount(() => {
    void initialize();
  });

  async function initialize(): Promise<void> {
    if (!container) return;

    lastCols = cols;
    lastRows = rows;
    const terminal = new WTerm(container, {
      cols,
      rows,
      autoResize: true,
      onData: (data) => sendInput(data),
      onResize: (nextCols, nextRows) => sendResize(nextCols, nextRows),
    });
    await terminal.init();

    // The component may have been destroyed while WASM was initializing.
    if (destroyed) {
      terminal.destroy();
      return;
    }
    term = terminal;

    // Match the page's scheme so an HTTPS-served UI doesn't trip mixed-content
    // blocking (the /pty Bun.serve server has no TLS of its own, so wss would
    // require an external terminator).
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${scheme}://${window.location.hostname}:${wsPort}/pty?connectionId=${encodeURIComponent(connectionId)}`;
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      // Flush the current terminal size: the initial autoResize measurement may
      // have fired (and been dropped) while the socket was still connecting.
      sendResize(lastCols, lastRows);
    };
    socket.onmessage = (event: MessageEvent) => {
      handlePtyFrame(event.data as string | ArrayBuffer);
    };
    // Surface connection failures so a misconfigured port/origin (or a rejected
    // upgrade) is diagnosable rather than presenting as a dead black terminal.
    socket.onerror = () => {
      console.warn(`PTY websocket error for connection ${connectionId} on port ${wsPort}`);
    };
    socket.onclose = (event: CloseEvent) => {
      if (!destroyed && !event.wasClean) {
        console.warn(
          `PTY websocket closed unexpectedly for connection ${connectionId} (code ${event.code})`
        );
      }
    };
    ws = socket;

    term.focus();
  }

  // The session detail page wraps SessionDetail (and therefore Terminal) in
  // `{#key session.connectionId}`, so switching sessions fully destroys and
  // remounts this component — onDestroy alone covers every teardown case. We
  // intentionally do NOT use afterNavigate here: it fires on *arrival* (the
  // navigation that mounted the component), so a path-changed teardown would
  // run immediately on mount and kill the terminal before it connects.
  onDestroy(() => {
    teardown();
  });
</script>

<div class="terminal-viewport" data-testid="pty-terminal-viewport" bind:this={container}></div>

<style>
  .terminal-viewport {
    height: 100%;
    min-height: 0;
    width: 100%;
    overflow: hidden;
    background: #000;
  }

  .terminal-viewport:global(.wterm) {
    box-sizing: border-box;
    display: block;
    height: 100%;
    max-height: 100%;
    min-height: 0;
    width: 100%;
    max-width: 100%;
    border-radius: 0;
    box-shadow: none;
  }

  .terminal-viewport:global(.wterm.has-scrollback) {
    overflow: auto;
  }
</style>
