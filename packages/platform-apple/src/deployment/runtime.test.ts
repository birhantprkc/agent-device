import { expect, test, vi } from 'vitest';
import type { AppleAppDeploymentExecutor } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { appleAppDeploymentFacts, createAppleAppDeploymentOperations } from './runtime.ts';

function appleDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'ios',
    id: 'apple-deployment-fact',
    name: 'Apple',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
    ...overrides,
  };
}

async function withoutInvalidatingAppResolutionCache<Result>(
  _device: DeviceInfo,
  operation: () => Promise<Result>,
): Promise<Result> {
  return await operation();
}

test.each([
  ['iOS simulator', appleDevice(), true, true, undefined],
  ['legacy unstamped iOS simulator', appleDevice({ appleOs: undefined }), true, true, undefined],
  [
    'iOS CoreDevice physical device',
    appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'coredevice' }),
    true,
    false,
    'unsupported-device-kind',
  ],
  [
    'iOS XCTest physical device',
    appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'xctest' }),
    false,
    false,
    'unsupported-device-backend',
  ],
  ['iPadOS simulator', appleDevice({ appleOs: 'ipados' }), true, true, undefined],
  [
    'iPadOS CoreDevice physical device',
    appleDevice({ appleOs: 'ipados', kind: 'device', iosPhysicalDeviceBackend: 'coredevice' }),
    true,
    false,
    'unsupported-device-kind',
  ],
  [
    'iPadOS XCTest physical device',
    appleDevice({ appleOs: 'ipados', kind: 'device', iosPhysicalDeviceBackend: 'xctest' }),
    false,
    false,
    'unsupported-device-backend',
  ],
  ['tvOS simulator', appleDevice({ appleOs: 'tvos', target: 'tv' }), true, true, undefined],
  [
    'tvOS CoreDevice physical device',
    appleDevice({
      appleOs: 'tvos',
      kind: 'device',
      target: 'tv',
      iosPhysicalDeviceBackend: 'coredevice',
    }),
    true,
    false,
    'unsupported-device-kind',
  ],
  [
    'tvOS XCTest physical device',
    appleDevice({
      appleOs: 'tvos',
      kind: 'device',
      target: 'tv',
      iosPhysicalDeviceBackend: 'xctest',
    }),
    false,
    false,
    'unsupported-device-backend',
  ],
  ['visionOS simulator', appleDevice({ appleOs: 'visionos' }), true, true, undefined],
  [
    'visionOS CoreDevice physical device',
    appleDevice({ appleOs: 'visionos', kind: 'device', iosPhysicalDeviceBackend: 'coredevice' }),
    true,
    false,
    'unsupported-device-kind',
  ],
  [
    'visionOS XCTest physical device',
    appleDevice({ appleOs: 'visionos', kind: 'device', iosPhysicalDeviceBackend: 'xctest' }),
    false,
    false,
    'unsupported-device-backend',
  ],
  [
    'macOS host',
    appleDevice({ appleOs: 'macos', kind: 'device', target: 'desktop' }),
    false,
    false,
    'unsupported-platform-leaf',
  ],
  [
    'macOS simulator sentinel',
    appleDevice({ appleOs: 'macos', kind: 'simulator', target: 'desktop' }),
    false,
    false,
    'unsupported-platform-leaf',
  ],
  [
    'watchOS sentinel',
    appleDevice({ appleOs: 'watchos' }),
    false,
    false,
    'unsupported-platform-leaf',
  ],
  [
    'watchOS physical sentinel',
    appleDevice({ appleOs: 'watchos', kind: 'device', iosPhysicalDeviceBackend: 'coredevice' }),
    false,
    false,
    'unsupported-platform-leaf',
  ],
  [
    'invalid Apple emulator kind',
    appleDevice({ kind: 'emulator' }),
    false,
    false,
    'unsupported-device-kind',
  ],
] as const)(
  'classifies deployment facts for the %s denominator cell',
  (_name, device, deployAvailable, pushAvailable, unavailableReason) => {
    const facts = appleAppDeploymentFacts(device);
    for (const operation of [
      facts.deployApp,
      facts.materializeAppSource,
      facts.deployMaterializedApp,
    ]) {
      expect(operation.available).toBe(deployAvailable);
    }
    expect(facts.sendPushNotification.available).toBe(pushAvailable);
    if (unavailableReason) {
      expect(deployAvailable ? facts.sendPushNotification : facts.deployApp).toMatchObject({
        reason: unavailableReason,
      });
    }
    if (device.iosPhysicalDeviceBackend === 'xctest') {
      expect(facts.deployApp).toMatchObject({ hint: expect.stringContaining('CoreDevice-backed') });
    }
  },
);

test('exposes only fact-admitted Apple deployment operations', async () => {
  const cleanup = vi.fn(async () => {});
  const prepareArtifact = vi.fn(async () => ({
    installablePath: '/tmp/App.app',
    bundleId: 'com.example.app',
    appName: 'Example',
    cleanup,
  }));
  const install = vi.fn(async () => {});
  const uninstall = vi.fn(async () => ({ bundleId: 'com.example.replaced' }));
  const push = vi.fn(async () => {});
  const executor = {
    prepareArtifact,
    install,
    uninstall,
    push,
    withInvalidatedAppResolutionCache: withoutInvalidatingAppResolutionCache,
  } as AppleAppDeploymentExecutor;
  const device = appleDevice();
  const signal = new AbortController().signal;
  const operations = createAppleAppDeploymentOperations({
    executor,
    device,
    signal,
  });

  await operations.deployApp?.({
    app: 'com.example.app',
    appPath: '/tmp/App.app',
    replaceExisting: false,
  });
  const artifact = await operations.materializeAppSource?.({
    source: { kind: 'path', path: '/tmp/App.app' },
  });
  await operations.deployMaterializedApp?.({ artifact: artifact! });
  await operations.sendPushNotification?.({ appId: 'com.example.app', payload: {} });
  await operations.deployApp?.({
    app: 'com.example.replaced',
    appPath: '/tmp/App.app',
    replaceExisting: true,
  });

  expect(prepareArtifact).toHaveBeenCalledTimes(3);
  expect(install).toHaveBeenCalledTimes(3);
  expect(uninstall).toHaveBeenCalledOnce();
  expect(push).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(uninstall).toHaveBeenCalledWith(device, 'com.example.replaced', signal);
  expect(install).toHaveBeenCalledWith(device, '/tmp/App.app', signal);
  expect(push).toHaveBeenCalledWith(device, { appId: 'com.example.app', payload: {} }, signal);
  expect(prepareArtifact).toHaveBeenNthCalledWith(
    1,
    { source: { kind: 'path', path: '/tmp/App.app' } },
    expect.objectContaining({ appIdentifierHint: 'com.example.app' }),
  );
  expect(prepareArtifact).toHaveBeenNthCalledWith(
    2,
    { source: { kind: 'path', path: '/tmp/App.app' } },
    expect.not.objectContaining({ appIdentifierHint: expect.anything() }),
  );
  expect(
    createAppleAppDeploymentOperations({
      executor,
      device: appleDevice({ appleOs: 'macos', kind: 'device', target: 'desktop' }),
      signal: new AbortController().signal,
    }),
  ).toEqual({});
});

test('preserves Apple reinstall partial-failure ordering', async () => {
  const order: string[] = [];
  const uninstall = vi.fn(async () => {
    order.push('uninstall');
    return { bundleId: 'com.example.replaced' };
  });
  const prepareArtifact = vi.fn(async () => {
    order.push('prepare');
    throw new Error('replacement artifact is invalid');
  });
  const install = vi.fn(async () => {
    order.push('install');
  });
  const executor = {
    prepareArtifact,
    install,
    uninstall,
    push: async () => {},
    withInvalidatedAppResolutionCache: withoutInvalidatingAppResolutionCache,
  } as AppleAppDeploymentExecutor;
  const operations = createAppleAppDeploymentOperations({
    executor,
    device: appleDevice(),
    signal: new AbortController().signal,
  });

  await expect(
    operations.deployApp?.({
      app: 'com.example.replaced',
      appPath: '/tmp/replacement.app',
      replaceExisting: true,
    }),
  ).rejects.toThrow('replacement artifact is invalid');

  expect(order).toEqual(['uninstall', 'prepare']);
  expect(install).not.toHaveBeenCalled();
});

test('clears a concurrently repopulated fuzzy resolution after a partial-failed Apple reinstall', async () => {
  const cachedResolutions = new Map([['Maps', 'com.example.stale-before-uninstall']]);
  let nextResolution = 'com.example.current';
  const resolveFuzzyTarget = vi.fn(async (target: string) => {
    const resolved = cachedResolutions.get(target) ?? nextResolution;
    cachedResolutions.set(target, resolved);
    return resolved;
  });
  const invalidateDuringUninstall = async <Result>(operation: () => Promise<Result>) => {
    cachedResolutions.clear();
    try {
      return await operation();
    } finally {
      cachedResolutions.clear();
    }
  };
  const uninstall = vi.fn(
    async (_device: DeviceInfo, app: string) =>
      await invalidateDuringUninstall(async () => {
        const bundleId = await resolveFuzzyTarget(app);
        expect(bundleId).toBe('com.example.current');
        return { bundleId };
      }),
  );
  const prepareArtifact = vi.fn(async () => {
    const repopulate = Promise.resolve().then(async () => {
      nextResolution = 'com.example.stale-after-uninstall';
      await resolveFuzzyTarget('Maps');
    });
    await repopulate;
    throw new Error('replacement artifact is invalid');
  });
  const withInvalidatedAppResolutionCache = vi.fn(
    async <Result>(_device: DeviceInfo, operation: () => Promise<Result>): Promise<Result> => {
      cachedResolutions.clear();
      try {
        return await operation();
      } finally {
        cachedResolutions.clear();
      }
    },
  );
  const executor = {
    prepareArtifact,
    install: async () => {},
    uninstall,
    push: async () => {},
    withInvalidatedAppResolutionCache,
  } as AppleAppDeploymentExecutor;
  const operations = createAppleAppDeploymentOperations({
    executor,
    device: appleDevice(),
    signal: new AbortController().signal,
  });

  await expect(
    operations.deployApp?.({
      app: 'Maps',
      appPath: '/tmp/replacement.app',
      replaceExisting: true,
    }),
  ).rejects.toThrow('replacement artifact is invalid');

  // The low-level uninstall scope clears its own cache, but a resolution racing artifact
  // preparation can repopulate it. The whole reinstall scope must clear that stale value even
  // when preparation fails before any install attempt.
  expect(cachedResolutions).toEqual(new Map());
  expect(withInvalidatedAppResolutionCache).toHaveBeenCalledOnce();
  expect(resolveFuzzyTarget).toHaveBeenCalledTimes(2);
});
