import { expect, test, vi } from 'vitest';
import type { AndroidAppDeploymentExecutor } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { androidAppDeploymentFacts, createAndroidAppDeploymentOperations } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'android-deployment-fact',
  name: 'Android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

async function withoutInvalidatingAppResolutionCache<Result>(
  _device: DeviceInfo,
  operation: () => Promise<Result>,
): Promise<Result> {
  return await operation();
}

test.each([
  ['emulator', device, true],
  ['physical device', { ...device, kind: 'device' as const }, true],
  ['invalid simulator kind', { ...device, kind: 'simulator' as const }, false],
] as const)(
  'classifies Android deployment facts for the %s denominator cell',
  (_name, runtimeDevice, available) => {
    const facts = androidAppDeploymentFacts(runtimeDevice);
    for (const fact of Object.values(facts)) {
      expect(fact.available).toBe(available);
      if (!available) expect(fact).toMatchObject({ reason: 'unsupported-device-kind' });
    }
  },
);

test('exposes all Android deployment operations only for admitted kinds', async () => {
  const cleanup = vi.fn(async () => {});
  const ensureBooted = vi.fn(async () => {});
  const prepareArtifact = vi.fn(async () => ({
    installablePath: '/tmp/app.apk',
    packageName: 'com.example.app',
    cleanup,
  }));
  const install = vi.fn(async () => 'com.example.app');
  const uninstall = vi.fn(async () => ({ packageName: 'com.example.replaced' }));
  const appName = vi.fn(async () => 'Example');
  const push = vi.fn(async () => ({ action: 'com.example.app.TEST_PUSH', extrasCount: 0 }));
  const executor = {
    ensureBooted,
    withInvalidatedAppResolutionCache: withoutInvalidatingAppResolutionCache,
    prepareArtifact,
    install,
    uninstall,
    appName,
    push,
  } as AndroidAppDeploymentExecutor;
  const signal = new AbortController().signal;
  const operations = createAndroidAppDeploymentOperations({
    executor,
    device,
    signal,
  });

  await operations.deployApp?.({ app: '', appPath: '/tmp/app.apk', replaceExisting: false });
  const artifact = await operations.materializeAppSource?.({
    source: { kind: 'path', path: '/tmp/app.apk' },
  });
  await operations.deployMaterializedApp?.({ artifact: artifact! });
  await operations.sendPushNotification?.({ appId: 'com.example.app', payload: {} });
  await operations.deployApp?.({
    app: 'com.example.replaced',
    appPath: '/tmp/app.apk',
    replaceExisting: true,
  });

  expect(prepareArtifact).toHaveBeenCalledTimes(3);
  expect(install).toHaveBeenCalledTimes(3);
  expect(uninstall).toHaveBeenCalledOnce();
  expect(appName).toHaveBeenCalledTimes(2);
  expect(push).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(uninstall).toHaveBeenCalledWith(device, 'com.example.replaced', signal);
  expect(install).toHaveBeenCalledWith(device, '/tmp/app.apk', {
    packageNameHint: 'com.example.app',
    signal,
  });
  expect(push).toHaveBeenCalledWith(device, { appId: 'com.example.app', payload: {} }, signal);
  expect(prepareArtifact).toHaveBeenNthCalledWith(
    1,
    { source: { kind: 'path', path: '/tmp/app.apk' } },
    expect.objectContaining({ resolveIdentity: true }),
  );
  expect(prepareArtifact).toHaveBeenNthCalledWith(
    3,
    { source: { kind: 'path', path: '/tmp/app.apk' } },
    expect.objectContaining({ resolveIdentity: false }),
  );
  expect(
    createAndroidAppDeploymentOperations({
      executor,
      device: { ...device, kind: 'simulator' },
      signal: new AbortController().signal,
    }),
  ).toEqual({});
});

test('preserves the pre-install Android boot wait before artifact identity inspection', async () => {
  const order: string[] = [];
  const ensureBooted = vi.fn(async () => {
    order.push('ready');
  });
  const prepareArtifact = vi.fn(async () => {
    order.push('prepare');
    return {
      installablePath: '/tmp/app.apk',
      packageName: 'com.example.app',
      cleanup: async () => {},
    };
  });
  const executor = {
    ensureBooted,
    withInvalidatedAppResolutionCache: withoutInvalidatingAppResolutionCache,
    prepareArtifact,
    install: async () => 'com.example.app',
    uninstall: async () => ({ packageName: 'com.example.app' }),
    appName: async () => 'Example',
    push: async () => ({}),
  } as AndroidAppDeploymentExecutor;
  const signal = new AbortController().signal;
  const operations = createAndroidAppDeploymentOperations({
    executor,
    device: { ...device, booted: false },
    signal,
  });

  await operations.deployApp?.({ app: '', appPath: '/tmp/app.apk', replaceExisting: false });

  expect(ensureBooted).toHaveBeenCalledWith({ ...device, booted: false }, signal);
  expect(order).toEqual(['ready', 'prepare']);
});

test('preserves Android reinstall partial-failure ordering', async () => {
  const order: string[] = [];
  const uninstall = vi.fn(async () => {
    order.push('uninstall');
    return { packageName: 'com.example.replaced' };
  });
  const prepareArtifact = vi.fn(async () => {
    order.push('prepare');
    throw new Error('replacement artifact is invalid');
  });
  const install = vi.fn(async () => {
    order.push('install');
    return 'com.example.replaced';
  });
  const executor = {
    ensureBooted: async () => {},
    withInvalidatedAppResolutionCache: withoutInvalidatingAppResolutionCache,
    prepareArtifact,
    install,
    uninstall,
    appName: async () => 'Example',
    push: async () => ({}),
  } as AndroidAppDeploymentExecutor;
  const operations = createAndroidAppDeploymentOperations({
    executor,
    device,
    signal: new AbortController().signal,
  });

  await expect(
    operations.deployApp?.({
      app: 'com.example.replaced',
      appPath: '/tmp/replacement.apk',
      replaceExisting: true,
    }),
  ).rejects.toThrow('replacement artifact is invalid');

  expect(order).toEqual(['uninstall', 'prepare']);
  expect(install).not.toHaveBeenCalled();
});

test('clears cached fuzzy Android resolution before and after the whole reinstall', async () => {
  const cachedResolutions = new Map([['Maps', 'com.example.stale']]);
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
  const resolveFuzzyTarget = vi.fn(async (target: string) => {
    const resolved = cachedResolutions.get(target) ?? 'com.example.current';
    cachedResolutions.set(target, resolved);
    return resolved;
  });
  const uninstall = vi.fn(async (_device: DeviceInfo, app: string) => {
    const packageName = await resolveFuzzyTarget(app);
    if (packageName !== 'com.example.current') {
      throw new Error(`stale fuzzy target: ${packageName}`);
    }
    return { packageName };
  });
  const install = vi.fn(async () => {
    cachedResolutions.set('Maps', 'com.example.replacement');
    return 'com.example.current';
  });
  const executor = {
    ensureBooted: async () => {},
    prepareArtifact: async () => ({
      installablePath: '/tmp/replacement.apk',
      cleanup: async () => {},
    }),
    install,
    uninstall,
    appName: async () => 'Example',
    push: async () => ({}),
    withInvalidatedAppResolutionCache,
  } as AndroidAppDeploymentExecutor;
  const operations = createAndroidAppDeploymentOperations({
    executor,
    device,
    signal: new AbortController().signal,
  });

  await expect(
    operations.deployApp?.({
      app: 'Maps',
      appPath: '/tmp/replacement.apk',
      replaceExisting: true,
    }),
  ).resolves.toEqual({ packageName: 'com.example.current', launchTarget: 'com.example.current' });

  expect(withInvalidatedAppResolutionCache).toHaveBeenCalledOnce();
  expect(resolveFuzzyTarget).toHaveBeenCalledWith('Maps');
  expect(cachedResolutions).toEqual(new Map());
});

test('keeps ordinary Android install successful when identity is unavailable', async () => {
  const appName = vi.fn(async () => 'should not be called');
  const executor = {
    ensureBooted: async () => {},
    withInvalidatedAppResolutionCache: withoutInvalidatingAppResolutionCache,
    prepareArtifact: async () => ({
      installablePath: '/tmp/app.apk',
      cleanup: async () => {},
    }),
    install: async () => undefined,
    uninstall: async () => ({ packageName: 'com.example.app' }),
    appName,
    push: async () => ({}),
  } as AndroidAppDeploymentExecutor;
  const operations = createAndroidAppDeploymentOperations({
    executor,
    device,
    signal: new AbortController().signal,
  });

  await expect(
    operations.deployApp?.({ app: '', appPath: '/tmp/app.apk', replaceExisting: false }),
  ).resolves.toEqual({});
  expect(appName).not.toHaveBeenCalled();
});
