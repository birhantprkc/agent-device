import type {
  AndroidAppDeploymentExecutor,
  MaterializeAppSourceInput,
  PushNotificationInput,
} from '@agent-device/contracts/platform';

/**
 * Native Android executor port. The Android package owns deployment sequencing and cache scope;
 * this adapter supplies only lazy ADB/artifact mechanics.
 */
export function createAndroidAppDeploymentExecutor(): AndroidAppDeploymentExecutor {
  return Object.freeze({
    ensureBooted: async (device, signal) => {
      if (device.booted === true) return;
      signal.throwIfAborted();
      const { waitForAndroidBoot } = await import('./platforms/android/emulator-lifecycle.ts');
      await waitForAndroidBoot(device.id, undefined, signal);
    },
    withInvalidatedAppResolutionCache: async (device, operation) => {
      const { withAndroidAppResolutionCacheInvalidated } =
        await import('./platforms/android/app-deployment-resolution.ts');
      return await withAndroidAppResolutionCacheInvalidated(device, operation);
    },
    prepareArtifact: async (input: MaterializeAppSourceInput, options) => {
      const { prepareAndroidInstallArtifact } =
        await import('./platforms/android/install-artifact.ts');
      return await prepareAndroidInstallArtifact(input.source, options);
    },
    install: async (device, installablePath, options) => {
      const { installAndroidInstallablePathAndResolvePackageName } =
        await import('./platforms/android/app-deployment.ts');
      return await installAndroidInstallablePathAndResolvePackageName(
        device,
        installablePath,
        options.packageNameHint,
        { signal: options.signal },
      );
    },
    uninstall: async (device, app, signal) => {
      const { uninstallAndroidApp } = await import('./platforms/android/app-deployment.ts');
      const result = await uninstallAndroidApp(device, app, { signal });
      return { packageName: result.package };
    },
    appName: async (packageName) => {
      const { inferAndroidAppName } =
        await import('./platforms/android/app-deployment-resolution.ts');
      return inferAndroidAppName(packageName);
    },
    push: async (device, input: PushNotificationInput, signal) => {
      const { pushAndroidNotification } = await import('./platforms/android/notifications.ts');
      return await pushAndroidNotification(device, input.appId, input.payload, { signal });
    },
  });
}
