import type {
  AppDeploymentInput,
  AppDeploymentResult,
  AppDeploymentRuntimeOperations,
  AndroidAppDeploymentExecutor,
  DeployMaterializedAppInput,
  MaterializeAppSourceInput,
  PushNotificationInput,
  RuntimeOperationFact,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

const available = Object.freeze({ available: true } as const);

export function androidAppDeploymentFacts(device: DeviceInfo): Readonly<{
  deployApp: RuntimeOperationFact;
  materializeAppSource: RuntimeOperationFact;
  deployMaterializedApp: RuntimeOperationFact;
  sendPushNotification: RuntimeOperationFact;
}> {
  const fact = androidDeployFact(device);
  return Object.freeze({
    deployApp: fact,
    materializeAppSource: fact,
    deployMaterializedApp: fact,
    sendPushNotification: fact,
  });
}

export function createAndroidAppDeploymentOperations(params: {
  executor: AndroidAppDeploymentExecutor;
  device: DeviceInfo;
  signal: AbortSignal;
}): Partial<AppDeploymentRuntimeOperations> {
  const { executor, device, signal } = params;
  const facts = androidAppDeploymentFacts(device);
  if (!facts.deployApp.available) return Object.freeze({});
  return Object.freeze({
    deployApp: async (input: AppDeploymentInput) =>
      await deployAndroidApp(executor, device, input, signal),
    materializeAppSource: async (input: MaterializeAppSourceInput) =>
      await executor.prepareArtifact(input, { signal }),
    deployMaterializedApp: async (input: DeployMaterializedAppInput) =>
      await deployPreparedAndroidApp(executor, device, input, signal),
    sendPushNotification: async (input: PushNotificationInput) =>
      await executor.push(device, input, signal),
  });
}

async function deployAndroidApp(
  executor: AndroidAppDeploymentExecutor,
  device: DeviceInfo,
  input: AppDeploymentInput,
  signal: AbortSignal,
): Promise<AppDeploymentResult> {
  if (input.replaceExisting) {
    // Reinstall resolves its fuzzy target during uninstall. Keep the old whole-operation
    // cache boundary here in the Android deployment owner: clear before boot/resolve/uninstall
    // and after materialization/install, including partial failures.
    return await executor.withInvalidatedAppResolutionCache(device, async () => {
      if (device.booted !== true) {
        await executor.ensureBooted(device, signal);
      }
      const { packageName } = await executor.uninstall(device, input.app, signal);
      const artifact = await executor.prepareArtifact(
        { source: { kind: 'path', path: input.appPath } },
        { resolveIdentity: false, signal },
      );
      try {
        await executor.install(device, artifact.installablePath, { signal });
        return { packageName, launchTarget: packageName };
      } finally {
        await artifact.cleanup();
      }
    });
  }

  // Existing install semantics wait for a selected Android target before taking the
  // before-install package inventory. Keep that platform rule here, rather than
  // reviving a daemon readiness adapter.
  if (device.booted !== true) {
    await executor.ensureBooted(device, signal);
  }

  const artifact = await executor.prepareArtifact(
    { source: { kind: 'path', path: input.appPath } },
    { resolveIdentity: true, signal },
  );
  try {
    const packageName = await executor.install(device, artifact.installablePath, {
      packageNameHint: artifact.packageName,
      signal,
    });
    // Plain install has historically succeeded even when the device cannot report the
    // installed package identity. Source installation is stricter because its response
    // contract promises an identity after materialization.
    if (!packageName) return {};
    return {
      packageName,
      appName: await executor.appName(packageName),
      launchTarget: packageName,
    };
  } finally {
    await artifact.cleanup();
  }
}

async function deployPreparedAndroidApp(
  executor: AndroidAppDeploymentExecutor,
  device: DeviceInfo,
  input: DeployMaterializedAppInput,
  signal: AbortSignal,
): Promise<AppDeploymentResult> {
  const packageName = await executor.install(device, input.artifact.installablePath, {
    packageNameHint: input.artifact.packageName,
    signal,
  });
  if (!packageName) {
    throw new AppError(
      'COMMAND_FAILED',
      'Installed Android app identity could not be resolved from the artifact or device state',
    );
  }
  return {
    packageName,
    appName: await executor.appName(packageName),
    launchTarget: packageName,
  };
}

function androidDeployFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.kind === 'emulator' || device.kind === 'device') return available;
  return Object.freeze({ available: false, reason: 'unsupported-device-kind' } as const);
}
