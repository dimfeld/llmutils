let shuttingDown = false;
let signalExitCode: number | undefined;
let deferExit = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function getSignalExitCode(): number | undefined {
  return signalExitCode;
}

export function setShuttingDown(exitCode: number): void {
  if (!shuttingDown) {
    signalExitCode = exitCode;
  }
  shuttingDown = true;
}

/** When true, signal handlers set the flag instead of calling process.exit().
 *  Only timAgent() should enable this to allow async lifecycle shutdown. */
export function setDeferSignalExit(defer: boolean): void {
  deferExit = defer;
}

export function isDeferSignalExit(): boolean {
  return deferExit;
}

export function resetShutdownState(): void {
  shuttingDown = false;
  signalExitCode = undefined;
  deferExit = false;
}
