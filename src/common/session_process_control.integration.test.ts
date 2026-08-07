import { afterEach, describe, expect, it } from 'vitest';
import { spawnAndLogOutput, spawnWithStreamingIO, type StreamingProcess } from './process.js';
import {
  getCurrentSessionProcessOwner,
  runWithSessionProcessOwner,
  SessionProcessOwner,
} from './session_process_control.js';
import { SessionProcessRegistry, toProcessId, type ProcessId } from './session_process.js';

function processId(value: string): ProcessId {
  const result = toProcessId(value);
  if (!result) {
    throw new Error(`Invalid test process ID: ${value}`);
  }
  return result;
}

const describePlatform = process.platform === 'win32' ? describe.skip : describe;

describePlatform('session process control real-process integration', () => {
  let streaming: StreamingProcess | undefined;

  afterEach(async () => {
    const processToClean = streaming;
    streaming = undefined;
    if (!processToClean) {
      return;
    }
    try {
      processToClean.kill('SIGKILL');
    } catch {
      // The process may have exited during the assertion.
    }
    await processToClean.result.catch(() => {});
  });

  it('captures a real child identity and terminates only that child', async () => {
    const registry = new SessionProcessRegistry({ sessionId: 'real-session' });
    registry.register({ processId: processId('real-owner'), kind: 'tim', label: 'real owner' });
    const owner = new SessionProcessOwner({
      sessionId: 'real-session',
      ownerProcessId: processId('real-owner'),
      registry,
    });

    await runWithSessionProcessOwner(owner, async () => {
      expect(getCurrentSessionProcessOwner()).toBe(owner);
      const environmentResult = await spawnAndLogOutput(
        ['sh', '-c', 'printf "%s" "$TIM_PROCESS_ID"'],
        { quiet: true, sessionProcessLabel: 'environment executor' }
      );
      const environmentExecutor = registry
        .getSnapshot()
        .find((node) => node.label === 'environment executor');
      expect(environmentResult.stdout).toBe(environmentExecutor?.processId);

      streaming = await spawnWithStreamingIO(['sleep', '30'], {
        sessionProcessLabel: 'real sleep executor',
      });

      const executor = registry
        .getSnapshot()
        .find((node) => node.kind === 'executor' && node.state === 'running');
      expect(executor).toMatchObject({
        label: 'real sleep executor',
        pid: streaming.pid,
        startIdentity: expect.any(String),
      });

      expect(owner.terminateExecutor(executor!.processId)).toBe('terminated');
      const result = await streaming.result;
      expect(result.signal).toBe('SIGTERM');
      expect(registry.get(executor!.processId)?.state).toBe('exited');
    });

    owner.dispose();
  });

  it('does not track utility children without an explicit executor label', async () => {
    const registry = new SessionProcessRegistry({ sessionId: 'utility-session' });
    registry.register({
      processId: processId('utility-owner'),
      kind: 'tim',
      label: 'utility owner',
    });
    const owner = new SessionProcessOwner({
      sessionId: 'utility-session',
      ownerProcessId: processId('utility-owner'),
      registry,
    });

    const result = await runWithSessionProcessOwner(owner, () =>
      spawnAndLogOutput(['true'], { quiet: true })
    );
    expect(result.exitCode).toBe(0);
    expect(registry.getSnapshot()).toHaveLength(1);
    owner.dispose();
  });
});
