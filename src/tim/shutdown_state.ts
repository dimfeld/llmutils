let shuttingDown = false;
let signalExitCode: number | undefined;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function getSignalExitCode(): number | undefined {
  return signalExitCode;
}

export function setShuttingDown(exitCode: number): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  signalExitCode = exitCode;
}

export function resetShutdownState(): void {
  shuttingDown = false;
  signalExitCode = undefined;
}
