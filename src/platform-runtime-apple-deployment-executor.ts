import type {
  AppleAppDeploymentExecutor,
  MaterializeAppSourceInput,
  PushNotificationInput,
} from '@agent-device/contracts/platform';

/**
 * Native Apple executor port. The platform package owns deployment sequencing; this composition
 * adapter loads native mechanics only once an admitted Apple binding invokes an operation.
 */
export function createAppleAppDeploymentExecutor(): AppleAppDeploymentExecutor {
  return Object.freeze({
    withInvalidatedAppResolutionCache: async (device, operation) => {
      const { invalidateIosAppResolutionCache } =
        await import('./platforms/apple/core/app-resolution.ts');
      return await invalidateIosAppResolutionCache(device, operation);
    },
    prepareArtifact: async (input: MaterializeAppSourceInput, options) => {
      const { prepareIosInstallArtifact } =
        await import('./platforms/apple/core/install-artifact.ts');
      return await prepareIosInstallArtifact(input.source, options);
    },
    install: async (device, installablePath, signal) => {
      const { installIosInstallablePath } = await import('./platforms/apple/core/app-install.ts');
      await installIosInstallablePath(device, installablePath, { signal });
    },
    uninstall: async (device, app, signal) => {
      const { uninstallIosApp } = await import('./platforms/apple/core/app-install.ts');
      return await uninstallIosApp(device, app, { signal });
    },
    push: async (device, input: PushNotificationInput, signal) => {
      const { pushIosNotification } = await import('./platforms/apple/core/app-device-io.ts');
      await pushIosNotification(device, input.appId, input.payload, { signal });
    },
  });
}
