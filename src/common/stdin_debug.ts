const STDIN_DEBUG_ENABLED = process.env.TIM_DEBUG_STDIN === '1';
const STDIN_DEBUG_INSTALLED = Symbol.for('tim.stdinDebug.installed');

function safeWrite(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // Best-effort debug logging only.
  }
}

function formatStack(skipLines: number = 3, maxLines: number = 4): string {
  const stack = new Error().stack;
  if (!stack) {
    return 'no-stack';
  }

  const lines = stack
    .split('\n')
    .slice(skipLines, skipLines + maxLines)
    .map((line) => line.trim());
  return lines.join(' <- ');
}

function traceStdinCall(method: string, args: unknown[]): void {
  const ts = new Date().toISOString();
  const tty = process.stdin.isTTY;
  safeWrite(
    `[TIM_DEBUG_STDIN] ${ts} stdin.${method}(${args.map((v) => JSON.stringify(v)).join(', ')}) isTTY=${String(tty)} stack=${formatStack()}`
  );
}

function traceLifecycle(event: string): void {
  const ts = new Date().toISOString();
  safeWrite(`[TIM_DEBUG_STDIN] ${ts} lifecycle ${event}`);
}

function wrapStdinMethod(method: 'pause' | 'resume' | 'ref' | 'unref' | 'setRawMode'): void {
  const stdinObject = process.stdin as unknown as Record<string, unknown>;
  const original = stdinObject[method];
  if (typeof original !== 'function') {
    return;
  }

  stdinObject[method] = (...args: unknown[]) => {
    traceStdinCall(method, args);
    return (original as (...innerArgs: unknown[]) => unknown).apply(process.stdin, args);
  };
}

export function installStdinDebugTracing(): void {
  if (!STDIN_DEBUG_ENABLED) {
    return;
  }

  const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
  if (globalState[STDIN_DEBUG_INSTALLED]) {
    return;
  }
  globalState[STDIN_DEBUG_INSTALLED] = true;

  traceLifecycle('install');
  wrapStdinMethod('pause');
  wrapStdinMethod('resume');
  wrapStdinMethod('ref');
  wrapStdinMethod('unref');
  wrapStdinMethod('setRawMode');

  process.on('beforeExit', (code) => {
    traceLifecycle(`beforeExit code=${code}`);
  });
  process.on('exit', (code) => {
    traceLifecycle(`exit code=${code}`);
  });
}
