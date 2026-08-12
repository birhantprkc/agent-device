import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const { runHarmonyHdc } = vi.hoisted(() => ({ runHarmonyHdc: vi.fn() }));

vi.mock('./platforms/harmonyos/hdc.ts', () => ({ runHarmonyHdc }));

import { createHarmonyAppDeploymentExecutor } from './platform-runtime-harmony-deployment-executor.ts';

const device: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-executor',
  name: 'Harmony executor',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test('forwards the binding signal to the in-flight HDC install', async () => {
  const controller = new AbortController();
  const aborted = new Error('request aborted');
  runHarmonyHdc.mockImplementation(
    async (_device: DeviceInfo, _args: string[], options: Readonly<{ signal?: AbortSignal }>) =>
      await rejectWhenAborted(options.signal),
  );
  const executor = createHarmonyAppDeploymentExecutor();
  const pending = executor.install(device, '/tmp/App.hap', controller.signal);
  await vi.waitFor(() => expect(runHarmonyHdc).toHaveBeenCalledOnce());
  expect(runHarmonyHdc).toHaveBeenCalledWith(device, ['install', '-r', '/tmp/App.hap'], {
    signal: controller.signal,
    timeoutMs: 180_000,
  });
  controller.abort(aborted);

  await expect(pending).rejects.toBe(aborted);
});

async function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
  return await new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
