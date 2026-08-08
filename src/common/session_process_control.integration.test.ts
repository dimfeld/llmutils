import { afterEach, describe, expect, it } from 'vitest';
import { spawnAndLogOutput, spawnWithStreamingIO, type StreamingProcess } from './process.js';
import {
  createNestedTimProcessRuntime,
  getCurrentSessionProcessOwner,
  runWithSessionProcessOwner,
  SessionProcessOwner,
} from './session_process_control.js';
import {
  SessionProcessRegistry,
  TIM_OWNER_PROCESS_ID,
  TIM_PARENT_PROCESS_ID,
  TIM_PROCESS_ID,
  TIM_SESSION_ID,
  SessionProcessRegistryLifecycleSink,
  toProcessId,
  type SessionProcessLifecycleSink,
  type ProcessId,
} from './session_process.js';

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
  const owners: SessionProcessOwner[] = [];

  afterEach(async () => {
    const processToClean = streaming;
    streaming = undefined;
    if (processToClean) {
      try {
        processToClean.kill('SIGKILL');
      } catch {
        // The process may have exited during the assertion.
      }
      await processToClean.result.catch(() => {});
    }
    for (const owner of owners.splice(0)) {
      owner.dispose();
    }
  });

  function createTrackedOwner(
    sessionId: string,
    ownerId: string
  ): {
    registry: SessionProcessRegistry;
    owner: SessionProcessOwner;
  } {
    const registry = new SessionProcessRegistry({ sessionId });
    const ownerProcessId = processId(ownerId);
    registry.register({ processId: ownerProcessId, kind: 'tim', label: ownerId });
    const owner = new SessionProcessOwner({
      sessionId,
      ownerProcessId,
      lifecycleSink: new SessionProcessRegistryLifecycleSink(registry),
    });
    owners.push(owner);
    return { registry, owner };
  }

  it('captures a real child identity and terminates only that child', async () => {
    const registry = new SessionProcessRegistry({ sessionId: 'real-session' });
    registry.register({ processId: processId('real-owner'), kind: 'tim', label: 'real owner' });
    const owner = new SessionProcessOwner({
      sessionId: 'real-session',
      ownerProcessId: processId('real-owner'),
      lifecycleSink: new SessionProcessRegistryLifecycleSink(registry),
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

  it('supports graceful end handlers for tracked streaming children', async () => {
    const { registry, owner } = createTrackedOwner('graceful-session', 'graceful-owner');
    let endHandler: (() => void) | undefined;

    try {
      streaming = await runWithSessionProcessOwner(owner, () =>
        spawnWithStreamingIO(['cat'], {
          sessionProcessLabel: 'graceful executor',
          sessionProcessControl: 'both',
          onSessionProcessReady: (lifecycle) => {
            endHandler = () => streaming?.stdin.end();
            lifecycle.setGracefulEndHandler(endHandler);
          },
        })
      );

      const executor = registry.getSnapshot().find((node) => node.label === 'graceful executor');
      expect(executor).toMatchObject({
        control: 'both',
        state: 'running',
        pid: streaming.pid,
      });
      expect(owner.endExecutor(executor!.processId)).toBe('ended');
      expect(await streaming.result).toMatchObject({ exitCode: 0, signal: null });
    } finally {
      owner.dispose();
    }
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
      lifecycleSink: new SessionProcessRegistryLifecycleSink(registry),
    });

    const result = await runWithSessionProcessOwner(owner, () =>
      spawnAndLogOutput(['true'], { quiet: true })
    );
    expect(result.exitCode).toBe(0);
    expect(registry.getSnapshot()).toHaveLength(1);
    owner.dispose();
  });

  it('orders registration before running and records successful, failed, and spawn-error exits', async () => {
    const { registry, owner } = createTrackedOwner('lifecycle-session', 'lifecycle-owner');
    const executorChanges: string[] = [];
    const unsubscribe = registry.subscribe((change) => {
      if ('node' in change && change.node.kind === 'executor') {
        executorChanges.push(change.type);
      }
    });

    try {
      const success = await runWithSessionProcessOwner(owner, () =>
        spawnAndLogOutput(['sh', '-c', 'printf success'], {
          quiet: true,
          sessionProcessLabel: 'successful executor',
        })
      );
      expect(success.exitCode).toBe(0);
      const successfulNode = registry
        .getSnapshot()
        .find((node) => node.label === 'successful executor');
      expect(successfulNode).toMatchObject({ state: 'exited', exitCode: 0 });
      expect(executorChanges.slice(0, 3)).toEqual(['registered', 'updated', 'exited']);

      const failed = await runWithSessionProcessOwner(owner, () =>
        spawnAndLogOutput(['sh', '-c', 'exit 7'], {
          quiet: true,
          sessionProcessLabel: 'failed executor',
        })
      );
      expect(failed.exitCode).toBe(7);
      expect(registry.getSnapshot().find((node) => node.label === 'failed executor')).toMatchObject(
        { state: 'exited', exitCode: 7 }
      );

      await expect(
        runWithSessionProcessOwner(owner, () =>
          spawnAndLogOutput(['tim-command-that-does-not-exist-for-tests'], {
            quiet: true,
            sessionProcessLabel: 'spawn-error executor',
          })
        )
      ).rejects.toThrow();
      expect(
        registry.getSnapshot().find((node) => node.label === 'spawn-error executor')
      ).toMatchObject({ state: 'exited' });

      await expect(
        runWithSessionProcessOwner(owner, () =>
          spawnAndLogOutput(['true'], {
            quiet: true,
            sessionProcessLabel: 'post-spawn-error executor',
            onSpawn: () => {
              throw new Error('post-spawn setup failed');
            },
          })
        )
      ).rejects.toThrow('post-spawn setup failed');
      expect(
        registry.getSnapshot().find((node) => node.label === 'post-spawn-error executor')
      ).toMatchObject({ state: 'exited' });
      expect(owner.childCount).toBe(0);
    } finally {
      unsubscribe();
      owner.dispose();
    }
  });

  it('unregisters a real streaming child when output processing fails', async () => {
    const { registry, owner } = createTrackedOwner('stream-error-session', 'stream-error-owner');

    try {
      streaming = await runWithSessionProcessOwner(owner, () =>
        spawnWithStreamingIO(['sh', '-c', 'printf output; sleep 30'], {
          quiet: true,
          sessionProcessLabel: 'formatter-error executor',
          formatStdout: () => {
            throw new Error('formatter failed');
          },
        })
      );

      await expect(streaming.result).rejects.toThrow('formatter failed');
      expect(
        registry.getSnapshot().find((node) => node.label === 'formatter-error executor')
      ).toMatchObject({ state: 'exited' });
      expect(owner.childCount).toBe(0);
    } finally {
      owner.dispose();
    }
  });

  it('propagates nested process identity values to a real executor child', async () => {
    const previousEnvironment = {
      [TIM_SESSION_ID]: process.env[TIM_SESSION_ID],
      [TIM_PROCESS_ID]: process.env[TIM_PROCESS_ID],
      [TIM_PARENT_PROCESS_ID]: process.env[TIM_PARENT_PROCESS_ID],
      [TIM_OWNER_PROCESS_ID]: process.env[TIM_OWNER_PROCESS_ID],
    };
    process.env[TIM_SESSION_ID] = 'nested-session';
    process.env[TIM_PROCESS_ID] = 'parent-executor';
    process.env[TIM_PARENT_PROCESS_ID] = 'root-owner';
    process.env[TIM_OWNER_PROCESS_ID] = 'root-owner';

    const registrations: Array<Record<string, unknown>> = [];
    const lifecycleSink: SessionProcessLifecycleSink = {
      registerProcess: (registration) => {
        registrations.push(registration);
        return true;
      },
      updateProcess: () => true,
      exitProcess: () => true,
      removeProcess: () => true,
    };

    let runtime: ReturnType<typeof createNestedTimProcessRuntime>;
    try {
      runtime = createNestedTimProcessRuntime(lifecycleSink, 'nested tim');
      expect(runtime).toBeDefined();
      if (!runtime) {
        throw new Error('Expected nested runtime');
      }

      const result = await runWithSessionProcessOwner(runtime.owner, () =>
        spawnAndLogOutput(
          [
            'sh',
            '-c',
            'printf "%s|%s|%s|%s" "$TIM_SESSION_ID" "$TIM_PROCESS_ID" "$TIM_PARENT_PROCESS_ID" "$TIM_OWNER_PROCESS_ID"',
          ],
          { quiet: true, sessionProcessLabel: 'nested executor' }
        )
      );
      const executorRegistration = registrations.find(
        (registration) => registration.kind === 'executor'
      );

      expect(executorRegistration).toBeDefined();
      expect(result.stdout).toBe(
        [
          'nested-session',
          executorRegistration?.processId,
          runtime.processId,
          runtime.processId,
        ].join('|')
      );
      expect(registrations.map((registration) => registration.kind)).toEqual(['tim', 'executor']);
    } finally {
      runtime?.dispose();
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
