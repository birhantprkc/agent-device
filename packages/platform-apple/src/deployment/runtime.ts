import type {
  AppDeploymentInput,
  AppDeploymentResult,
  AppDeploymentRuntimeOperations,
  AppleAppDeploymentExecutor,
  DeployMaterializedAppInput,
  MaterializeAppSourceInput,
  PushNotificationInput,
  RuntimeOperationFact,
} from '@agent-device/contracts/platform';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';

const available = Object.freeze({ available: true } as const);
const coreDeviceRequired = Object.freeze({
  available: false,
  reason: 'unsupported-device-backend',
  hint: 'This command requires a CoreDevice-backed physical iOS device. The selected XCTest backend supports open, close, interactions, snapshots, and screenshots.',
} as const);
const simulatorOnly = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'Push notifications are supported on Apple simulators only.',
} as const);
const unsupportedLeaf = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const unsupportedKind = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
} as const);

export function appleAppDeploymentFacts(device: DeviceInfo): Readonly<{
  deployApp: RuntimeOperationFact;
  materializeAppSource: RuntimeOperationFact;
  deployMaterializedApp: RuntimeOperationFact;
  sendPushNotification: RuntimeOperationFact;
}> {
  const deploy = appleDeployFact(device);
  return Object.freeze({
    deployApp: deploy,
    materializeAppSource: deploy,
    deployMaterializedApp: deploy,
    sendPushNotification: applePushFact(device),
  });
}

export function createAppleAppDeploymentOperations(params: {
  executor: AppleAppDeploymentExecutor;
  device: DeviceInfo;
  signal: AbortSignal;
}): Partial<AppDeploymentRuntimeOperations> {
  const { executor, device, signal } = params;
  const facts = appleAppDeploymentFacts(device);
  return Object.freeze({
    ...(facts.deployApp.available
      ? {
          deployApp: async (input: AppDeploymentInput) =>
            await deployAppleApp(executor, device, input, signal),
          materializeAppSource: async (input: MaterializeAppSourceInput) =>
            await executor.prepareArtifact(input, { signal }),
          deployMaterializedApp: async (input: DeployMaterializedAppInput) =>
            await deployPreparedAppleApp(executor, device, input, signal),
        }
      : {}),
    ...(facts.sendPushNotification.available
      ? {
          sendPushNotification: async (input: PushNotificationInput) => {
            await executor.push(device, input, signal);
            return {};
          },
        }
      : {}),
  });
}

async function deployAppleApp(
  executor: AppleAppDeploymentExecutor,
  device: DeviceInfo,
  input: AppDeploymentInput,
  signal: AbortSignal,
): Promise<AppDeploymentResult> {
  // Preserve reinstall's established partial-failure boundary: the old route resolved and
  // removed the selected app before it materialized the replacement artifact. That ordering is
  // observable when artifact preparation fails, so it belongs to the platform deployment facet.
  if (input.replaceExisting) {
    return await executor.withInvalidatedAppResolutionCache(device, async () => {
      const { bundleId } = await executor.uninstall(device, input.app, signal);
      const artifact = await executor.prepareArtifact(
        { source: { kind: 'path', path: input.appPath } },
        { appIdentifierHint: input.app, signal },
      );
      try {
        await executor.install(device, artifact.installablePath, signal);
        return { bundleId, launchTarget: bundleId };
      } finally {
        await artifact.cleanup();
      }
    });
  }

  const artifact = await executor.prepareArtifact(
    { source: { kind: 'path', path: input.appPath } },
    { appIdentifierHint: input.app, signal },
  );
  try {
    return await deployPreparedAppleApp(executor, device, { artifact }, signal);
  } finally {
    await artifact.cleanup();
  }
}

async function deployPreparedAppleApp(
  executor: AppleAppDeploymentExecutor,
  device: DeviceInfo,
  input: DeployMaterializedAppInput,
  signal: AbortSignal,
): Promise<AppDeploymentResult> {
  await executor.install(device, input.artifact.installablePath, signal);
  return {
    ...(input.artifact.bundleId ? { bundleId: input.artifact.bundleId } : {}),
    ...(input.artifact.appName ? { appName: input.artifact.appName } : {}),
    ...(input.artifact.bundleId ? { launchTarget: input.artifact.bundleId } : {}),
  };
}

function appleDeployFact(device: DeviceInfo): RuntimeOperationFact {
  if (!isSupportedAppleDeploymentLeaf(device)) return unsupportedLeaf;
  if (device.kind !== 'simulator' && device.kind !== 'device') return unsupportedKind;
  if (device.kind === 'device' && device.iosPhysicalDeviceBackend === 'xctest') {
    return coreDeviceRequired;
  }
  return available;
}

function applePushFact(device: DeviceInfo): RuntimeOperationFact {
  if (!isSupportedAppleDeploymentLeaf(device)) return unsupportedLeaf;
  return device.kind === 'simulator' ? available : simulatorOnly;
}

function isSupportedAppleDeploymentLeaf(device: DeviceInfo): boolean {
  return isIosFamily(device) && device.appleOs !== 'watchos';
}
