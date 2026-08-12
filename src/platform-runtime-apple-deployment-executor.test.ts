import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const {
  invalidateIosAppResolutionCache,
  installIosInstallablePath,
  pushIosNotification,
  uninstallIosApp,
} = vi.hoisted(() => ({
  invalidateIosAppResolutionCache: vi.fn(),
  installIosInstallablePath: vi.fn(),
  pushIosNotification: vi.fn(),
  uninstallIosApp: vi.fn(),
}));

vi.mock('./platforms/apple/core/app-install.ts', () => ({
  installIosInstallablePath,
  uninstallIosApp,
}));
vi.mock('./platforms/apple/core/app-device-io.ts', () => ({ pushIosNotification }));
vi.mock('./platforms/apple/core/app-resolution.ts', () => ({ invalidateIosAppResolutionCache }));

import { createAppleAppDeploymentExecutor } from './platform-runtime-apple-deployment-executor.ts';

const device: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'apple-executor',
  name: 'Apple executor',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

test('forwards the binding signal to every Apple deployment side effect', async () => {
  installIosInstallablePath.mockResolvedValue(undefined);
  uninstallIosApp.mockResolvedValue({ bundleId: 'com.example.app' });
  pushIosNotification.mockResolvedValue(undefined);
  const signal = new AbortController().signal;
  const executor = createAppleAppDeploymentExecutor();

  await executor.install(device, '/tmp/App.app', signal);
  await executor.uninstall(device, 'Example', signal);
  await executor.push(device, { appId: 'com.example.app', payload: {} }, signal);

  expect(installIosInstallablePath).toHaveBeenCalledWith(device, '/tmp/App.app', { signal });
  expect(uninstallIosApp).toHaveBeenCalledWith(device, 'Example', { signal });
  expect(pushIosNotification).toHaveBeenCalledWith(device, 'com.example.app', {}, { signal });
});

test('delegates the full Apple reinstall cache transaction to the lazy native executor', async () => {
  const operation = vi.fn(async () => 'completed');
  invalidateIosAppResolutionCache.mockImplementation(async (_device, scopedOperation) =>
    scopedOperation(),
  );
  const executor = createAppleAppDeploymentExecutor();

  await expect(executor.withInvalidatedAppResolutionCache(device, operation)).resolves.toBe(
    'completed',
  );

  expect(invalidateIosAppResolutionCache).toHaveBeenCalledWith(device, operation);
  expect(operation).toHaveBeenCalledOnce();
});
