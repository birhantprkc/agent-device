import type {
  AppDeploymentInput,
  AppDeploymentResult,
  AppDeploymentRuntimeOperations,
  HarmonyAppDeploymentExecutor,
  RuntimeOperationFact,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

const available = Object.freeze({ available: true } as const);
const unsupportedKind = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
} as const);
const unsupportedLeaf = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);

export function harmonyAppDeploymentFacts(device: DeviceInfo): Readonly<{
  deployApp: RuntimeOperationFact;
  materializeAppSource: RuntimeOperationFact;
  deployMaterializedApp: RuntimeOperationFact;
  sendPushNotification: RuntimeOperationFact;
}> {
  const deploy =
    device.kind === 'emulator' || device.kind === 'device' ? available : unsupportedKind;
  return Object.freeze({
    deployApp: deploy,
    materializeAppSource: unsupportedLeaf,
    deployMaterializedApp: unsupportedLeaf,
    sendPushNotification: unsupportedLeaf,
  });
}

export function createHarmonyAppDeploymentOperations(params: {
  executor: HarmonyAppDeploymentExecutor;
  device: DeviceInfo;
  signal: AbortSignal;
}): Partial<AppDeploymentRuntimeOperations> {
  const facts = harmonyAppDeploymentFacts(params.device);
  if (!facts.deployApp.available) return Object.freeze({});
  return Object.freeze({
    deployApp: async (input: AppDeploymentInput) =>
      await deployHarmonyApp(params.executor, params.device, input, params.signal),
  });
}

async function deployHarmonyApp(
  executor: HarmonyAppDeploymentExecutor,
  device: DeviceInfo,
  input: AppDeploymentInput,
  signal: AbortSignal,
): Promise<AppDeploymentResult> {
  const bundleId = (await executor.resolveBundleName(input.appPath, signal)) ?? input.app.trim();
  if (!bundleId) {
    throw new AppError('INVALID_ARGS', 'Could not determine the bundle name from the HAP archive', {
      hint: 'Pass the HarmonyOS bundle name before the HAP path, or provide a valid HAP containing module.json.',
    });
  }
  await executor.install(device, input.appPath, signal);
  if (input.replaceExisting) {
    // HDC returns after transfer; physical devices can still be replacing the running bundle.
    await executor.sleep(1_000, signal);
    await executor.open(device, bundleId, signal);
  }
  return { packageName: bundleId, launchTarget: bundleId };
}
