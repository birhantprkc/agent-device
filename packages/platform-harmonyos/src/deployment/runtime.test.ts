import { expect, test, vi } from 'vitest';
import type { HarmonyAppDeploymentExecutor } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createHarmonyAppDeploymentOperations, harmonyAppDeploymentFacts } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-deployment-fact',
  name: 'HarmonyOS',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test.each([
  ['emulator', device, true],
  ['physical device', { ...device, kind: 'device' as const }, true],
  ['invalid simulator kind', { ...device, kind: 'simulator' as const }, false],
] as const)(
  'classifies HarmonyOS deployment facts for the %s denominator cell',
  (_name, runtimeDevice, deployAvailable) => {
    const facts = harmonyAppDeploymentFacts(runtimeDevice);
    expect(facts.deployApp.available).toBe(deployAvailable);
    if (!deployAvailable)
      expect(facts.deployApp).toMatchObject({ reason: 'unsupported-device-kind' });
    for (const fact of [
      facts.materializeAppSource,
      facts.deployMaterializedApp,
      facts.sendPushNotification,
    ]) {
      expect(fact).toMatchObject({ available: false, reason: 'unsupported-platform-leaf' });
    }
  },
);

test('exposes only HarmonyOS deployApp after fact admission', async () => {
  const resolveBundleName = vi.fn(async () => 'com.example.app');
  const install = vi.fn(async () => {});
  const open = vi.fn(async () => {});
  const sleep = vi.fn(async () => {});
  const executor = { resolveBundleName, install, open, sleep } as HarmonyAppDeploymentExecutor;
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ executor, device, signal });
  await operations.deployApp?.({
    app: 'com.example.app',
    appPath: '/tmp/app.hap',
    replaceExisting: false,
  });
  await operations.deployApp?.({
    app: 'com.example.app',
    appPath: '/tmp/app.hap',
    replaceExisting: true,
  });
  expect(resolveBundleName).toHaveBeenCalledWith('/tmp/app.hap', signal);
  expect(resolveBundleName).toHaveBeenCalledTimes(2);
  expect(install).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(1_000, signal);
  expect(install).toHaveBeenCalledWith(device, '/tmp/app.hap', signal);
  expect(open).toHaveBeenCalledWith(device, 'com.example.app', signal);
  expect(operations).not.toHaveProperty('materializeAppSource');
  expect(
    createHarmonyAppDeploymentOperations({
      executor,
      device: { ...device, kind: 'simulator' },
      signal,
    }),
  ).toEqual({});
});
