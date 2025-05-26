/**
 * Detects if the current process is running within an SSH session
 * @returns true if running in an SSH session, false otherwise
 */
export function isSshSession(): boolean {
  return !!process.env.SSH_CLIENT || !!process.env.SSH_CONNECTION || !!process.env.SSH_TTY;
}

export function sshAwarePasteAction(): string {
  return isSshSession() ? 'paste the response back here' : 'copy the response and press Enter';
}
