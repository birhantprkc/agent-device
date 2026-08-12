import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const {
  installAndroidInstallablePathAndResolvePackageName,
  uninstallAndroidApp,
  pushAndroidNotification,
} = vi.hoisted(() => ({
  installAndroidInstallablePathAndResolvePackageName: vi.fn(),
  uninstallAndroidApp: vi.fn(),
  pushAndroidNotification: vi.fn(),
}));

vi.mock('./platforms/android/app-deployment.ts', () => ({
  installAndroidInstallablePathAndResolvePackageName,
  uninstallAndroidApp,
}));
vi.mock('./platforms/android/app-deployment-resolution.ts', () => ({
  withAndroidAppResolutionCacheInvalidated: async <Result>(
    _device: DeviceInfo,
    operation: () => Promise<Result>,
  ) => await operation(),
  inferAndroidAppName: (packageName: string) => packageName,
}));
vi.mock('./platforms/android/notifications.ts', () => ({ pushAndroidNotification }));

import { createAndroidAppDeploymentExecutor } from './platform-runtime-android-deployment-executor.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'android-executor',
  name: 'Android executor',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test('forwards the binding signal to Android install, uninstall, and push', async () => {
  installAndroidInstallablePathAndResolvePackageName.mockResolvedValue('com.example.app');
  uninstallAndroidApp.mockResolvedValue({ package: 'com.example.app' });
  pushAndroidNotification.mockResolvedValue({ action: 'com.example.PUSH', extrasCount: 0 });
  const signal = new AbortController().signal;
  const executor = createAndroidAppDeploymentExecutor();

  await executor.install(device, '/tmp/app.apk', { packageNameHint: 'com.example.app', signal });
  await executor.uninstall(device, 'Example', signal);
  await executor.push(device, { appId: 'com.example.app', payload: {} }, signal);

  expect(installAndroidInstallablePathAndResolvePackageName).toHaveBeenCalledWith(
    device,
    '/tmp/app.apk',
    'com.example.app',
    { signal },
  );
  expect(uninstallAndroidApp).toHaveBeenCalledWith(device, 'Example', { signal });
  expect(pushAndroidNotification).toHaveBeenCalledWith(device, 'com.example.app', {}, { signal });
});
